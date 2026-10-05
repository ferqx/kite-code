import fcntl
import json
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import termios
import time


root, bun, host, repository = sys.argv[1:]
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 0, 0))
events = []
started = time.monotonic()
child = None
normal = False
failure = None
token = 0


def pump(duration=0.05):
    end = time.monotonic() + duration
    while time.monotonic() < end:
        if select.select([master], [], [], 0.02)[0]:
            try:
                data = os.read(master, 65536)
            except OSError:
                return
            if not data:
                return
            events.append({'kind': 'data', 'hex': data.hex()})


def wait_ack(expected):
    end = time.monotonic() + 4
    while time.monotonic() < end:
        pump()
        try:
            with open(os.path.join(root, 'ack.json')) as handle:
                ack = json.load(handle)
            if ack['token'] == expected:
                pump(0.15)
                return ack
        except (FileNotFoundError, json.JSONDecodeError):
            pass
        if child.poll() is not None:
            raise RuntimeError('owned host exited before ack ' + str(expected))
    raise RuntimeError('owned host ack timeout ' + str(expected))


def control(action):
    global token
    token += 1
    path = os.path.join(root, 'control.json')
    with open(path + '.new', 'w') as handle:
        json.dump({'token': token, 'action': action}, handle)
    os.replace(path + '.new', path)
    return wait_ack(token)


def mark(name, ack=None):
    events.append({'kind': 'mark', 'name': name, 'ack': ack})


try:
    child = subprocess.Popen(
        [bun, host, root], stdin=slave, stdout=slave, stderr=slave,
        cwd=repository, start_new_session=True,
        env={**os.environ, 'TERM': 'xterm-256color', 'FORCE_COLOR': '3'},
    )
    os.close(slave)
    slave = None
    mark('round1', wait_ack(0))
    mark('round2', control('round2'))
    mark('round3', control('round3'))
    mark('status', control('status'))
    os.write(master, b'editing-safe')
    pump(0.4)
    mark('edited')
    os.write(master, b'\x7f' * len('editing-safe'))
    pump(0.2)
    for cols, name in [(40, 'narrow'), (80, 'restored')]:
        events.append({'kind': 'resize', 'cols': cols, 'rows': 24})
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', 24, cols, 0, 0))
        os.kill(child.pid, signal.SIGWINCH)
        pump(0.4)
        mark(name)
    mark('body-replaced', control('changed'))
    mark('cleared', control('clear'))
    mark('refreshed', control('refresh'))
    mark('changed', control('changed'))
    mark('session-b', control('session-b'))
    mark('session-a', control('session-a'))
    control('stop')
    pump(0.1)
    child.wait(timeout=3)
    normal = child.returncode == 0
except Exception as error:
    failure = str(error)
finally:
    if child is not None and child.poll() is None:
        child.terminate()
        try:
            child.wait(timeout=3)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait(timeout=3)
    if slave is not None:
        os.close(slave)
    os.close(master)
    with open(os.path.join(root, 'events.json'), 'w') as handle:
        json.dump({
            'pid': child.pid if child else None,
            'exitCode': child.returncode if child else None,
            'normalComplete': normal, 'failure': failure,
            'elapsedSeconds': time.monotonic() - started, 'events': events,
        }, handle)

sys.exit(0 if normal and failure is None else 1)
