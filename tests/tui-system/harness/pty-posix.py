"""Private test PTY. stdout carries exact terminal bytes; fd 3 carries control receipts."""
import base64
import errno
import fcntl
import json
import os
import pty
import selectors
import signal
import struct
import sys
import termios
import tty

cols, rows = map(int, sys.argv[1:3])
detach = sys.argv[3] == "detached"
command = sys.argv[4:]
master, slave = pty.openpty()
original = termios.tcgetattr(slave)
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
ready_read, ready_write = os.pipe()
pid = os.fork()
if pid == 0:
    try:
        os.close(3)
        os.close(ready_read)
        os.close(master)
        if detach:
            os.setsid()
            fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
            os.tcsetpgrp(slave, os.getpgrp())
        for fd in (0, 1, 2):
            os.dup2(slave, fd)
        if slave > 2:
            os.close(slave)
        os.write(ready_write, b"1")
        os.close(ready_write)
        os.execv(command[0], command)
    except BaseException as error:
        print(f"PTY child startup: {error}", file=sys.stderr)
        os._exit(127)
os.close(ready_write)
os.close(slave)
control = os.fdopen(3, "w", buffering=1)


def receipt(**value):
    control.write(json.dumps(value, separators=(",", ":")) + "\n")


def terminate(sig):
    try:
        if detach:
            os.killpg(pid, sig)
        else:
            os.kill(pid, sig)
    except ProcessLookupError:
        pass


def handle_term(signum, frame):
    terminate(signum)


signal.signal(signal.SIGTERM, handle_term)
signal.signal(signal.SIGINT, handle_term)
status = None
try:
    if os.read(ready_read, 1) != b"1":
        raise RuntimeError("PTY child did not initialize")
    receipt(pid=pid)
    with selectors.DefaultSelector() as selector:
        selector.register(master, selectors.EVENT_READ)
        selector.register(0, selectors.EVENT_READ)
        incoming = bytearray()
        terminal_open = True
        while terminal_open or status is None:
            if status is None:
                result, waited = os.waitpid(pid, os.WNOHANG)
                if result:
                    status = waited
            for key, _ in selector.select(0.05):
                if key.fd == master:
                    try:
                        data = os.read(master, 65536)
                    except OSError as error:
                        if error.errno != errno.EIO:
                            raise
                        data = b""
                    if not data:
                        selector.unregister(master)
                        terminal_open = False
                    else:
                        sys.stdout.buffer.write(data)
                        sys.stdout.buffer.flush()
                    continue
                chunk = os.read(0, 65536)
                if not chunk:
                    selector.unregister(0)
                    terminate(signal.SIGKILL)
                    continue
                incoming.extend(chunk)
                if len(incoming) > 2 * 1024 * 1024:
                    raise RuntimeError("PTY input frame too large")
                while b"\n" in incoming:
                    end = incoming.index(b"\n")
                    request = json.loads(incoming[:end])
                    del incoming[:end + 1]
                    kind = request["kind"]
                    if kind == "write":
                        data = memoryview(base64.b64decode(request["data"], validate=True))
                        while data:
                            data = data[os.write(master, data):]
                    elif kind == "resize":
                        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", request["rows"], request["cols"], 0, 0))
                    elif kind == "raw":
                        if request["enabled"]:
                            tty.setraw(master, termios.TCSANOW)
                        else:
                            termios.tcsetattr(master, termios.TCSANOW, original)
                    elif kind == "kill":
                        terminate(getattr(signal, request["signal"]))
                    elif kind == "hangup":
                        if terminal_open:
                            selector.unregister(master)
                            os.close(master)
                            terminal_open = False
                    else:
                        raise RuntimeError("Unexpected PTY request")
                    receipt(id=request["id"])
    code = os.waitstatus_to_exitcode(status)
    receipt(code=code if code >= 0 else 128 - code, signal=None if code >= 0 else signal.Signals(-code).name)
finally:
    os.close(ready_read)
    try:
        os.close(master)
    except OSError as error:
        if error.errno != errno.EBADF:
            raise
    if status is None:
        terminate(signal.SIGKILL)
        os.waitpid(pid, 0)
