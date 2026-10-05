import codecs
import fcntl
import json
import os
import pty
import re
import select
import signal
import struct
import subprocess
import sys
import termios
import time
import urllib.request

control_url, executable, host, root, evidence, detail, custom = sys.argv[1:]
process = None
master = None
buffer = ''
decoder = codecs.getincrementaldecoder('utf-8')('strict')
trace = []
failure = None
normal_complete = False
normal_ctrl_q = False
exit_code = None


def normalized():
    frames = buffer.split('\x1b[?2026h')
    frame = next((part.split('\x1b[?2026l')[0] for part in reversed(frames[1:])
                  if '\x1b[?2026l' in part), '')
    return re.sub(r'\s+', ' ', re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', frame))


def note(kind, **values):
    trace.append(dict(kind=kind, time=time.monotonic(), **values))


def receive(timeout=.05):
    global buffer
    if select.select([master], [], [], timeout)[0]:
        chunk = os.read(master, 65536)
        if not chunk:
            raise RuntimeError('owned_question_pty_eof')
        buffer = (buffer + decoder.decode(chunk))[-1048576:]


def drain(deadline=None):
    for _ in range(16):
        if not select.select([master], [], [], 0)[0]:
            return
        if deadline is not None and time.monotonic() > deadline:
            raise RuntimeError('owned_question_drain_deadline')
        receive(0)
    raise RuntimeError('owned_question_drain_limit')


def wait(text):
    deadline = time.monotonic() + 10
    while True:
        drain(deadline)
        if text in normalized():
            note('matched', text=text, frame=normalized())
            return
        if time.monotonic() > deadline:
            raise RuntimeError('owned_question_frame_deadline:' + text)
        receive()


def key(value, retain=False):
    global buffer
    drain()
    note('key', hex=value.hex(), frame=normalized())
    if not retain:
        buffer = ''
    os.write(master, value)


def check(stage):
    note('observe', stage=stage, frame=normalized())
    with urllib.request.urlopen(control_url + stage, timeout=12) as response:
        value = json.load(response)
        assert value['checked'] is True


def wait_exit(seconds):
    deadline = time.monotonic() + seconds
    while process.poll() is None and time.monotonic() < deadline:
        if select.select([master], [], [], .05)[0]:
            try:
                os.read(master, 65536)
            except OSError:
                break
    return process.wait(timeout=3)


try:
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 0, 0))
    process = subprocess.Popen([executable, host], stdin=slave, stdout=slave, stderr=slave,
                               start_new_session=True,
                               env=dict(os.environ, HOME=root, KITE_CODE_HOME=os.path.join(root, 'owned-home')))
    os.close(slave)
    wait('New Run >')
    key(b'/permissions')
    wait('New Run > /permissions')
    key(b'\r')
    wait('T review trust')
    key(b't')
    wait('Confirm original')
    key(b'\r')
    wait('workspace.trust: applied')
    wait('trusted, revision 1')
    wait('D toggle · Enter review mode choice')
    key(b'\r')
    wait('Confirm original')
    key(b'\r')
    wait('permission.mode: applied')
    key(b'\x1b')
    wait('New Run >')
    key(b'Ask the production default question')
    wait('New Run > Ask the production default question')
    key(b'\r')
    wait('Choose original route')
    wait('First original route')
    wait('Second original route')
    wait('First original route (Recommended)')
    assert 'q1-o1' not in normalized() and 'q1-o2' not in normalized()
    check('initial')
    key(b'\r', retain=True)
    wait('Choose original route')
    check('blank')
    key(b'\x1b[B')
    wait('› First original route')
    key(b'\r')
    wait('Write original detail')
    check('route')
    key(b'\x1b[B')
    wait('› Brief detail')
    key(b'\x1b[B')
    key(b'\x1b[B')
    wait('› Custom answer')
    # Bracketed paste is a real terminal key stream and keeps multiple lines in one draft.
    key(b'\x1b[200~' + detail.encode('utf-8') + b'\x1b[201~')
    wait('[Pasted ' + str(len(detail)) + ' characters]')
    check('text')
    key(b'\r')
    wait('Choose final delivery')
    check('text')
    key(b'\x1b')
    wait('Write original detail')
    wait('[Pasted ' + str(len(detail)) + ' characters]')
    check('back')
    key(b'\x1b')
    wait('Choose original route')
    key(b'\x1b[B')
    wait('› Second original route')
    key(b'\r')
    wait('Write original detail')
    wait('[Pasted ' + str(len(detail)) + ' characters]')
    check('retained')
    key(b'\r')
    wait('Choose final delivery')
    key(b'\x1b[B')
    wait('› Original delivery option')
    key(b'\x1b[B')
    key(b'\x1b[B')
    wait('› Custom answer')
    key(custom.encode('utf-8'))
    wait('q3-o1')
    check('custom')
    key(b'\r')
    check('finish')
    wait('OWNED_QUESTION_COMPLETE')
    wait('New Run >')
    key(b'\x11')
    exit_code = wait_exit(6)
    assert exit_code == 0
    normal_ctrl_q = True
    normal_complete = True
except BaseException as error:
    failure = repr(error)
    note('failure', message=failure, frame=normalized())
    raise
finally:
    # Only the still-held Popen child is signalled. It owns paired Service cleanup.
    if process is not None and process.poll() is None:
        process.send_signal(signal.SIGTERM)
        try:
            exit_code = wait_exit(6)
        except subprocess.TimeoutExpired:
            process.kill()
            exit_code = process.wait(timeout=3)
    if master is not None:
        os.close(master)
    for name, value in [
        ('pty-trace.json', dict(failure=failure, latestCompleteFrame=normalized(), trace=trace)),
        ('pty-exit.json', dict(normalComplete=normal_complete, normalCtrlQ=normal_ctrl_q,
                              pid=process.pid if process is not None else None, exitCode=exit_code)),
    ]:
        with os.fdopen(os.open(os.path.join(evidence, name), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600), 'w') as output:
            json.dump(value, output)
            output.flush()
            os.fsync(output.fileno())
