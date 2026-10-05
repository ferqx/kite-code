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

control_url, executable, host, root, evidence, store_id = sys.argv[1:]
process = None
master = None
buffer = ''
decoder = codecs.getincrementaldecoder('utf-8')('strict')
exits = []
trace = []
failure = None
complete = False


def note(kind, **values):
    trace.append(dict(kind=kind, time=time.monotonic(), **values))
    if len(trace) > 512:
        del trace[0]


def normalized():
    frames = buffer.split('\x1b[?2026h')
    frame = next((part.split('\x1b[?2026l')[0] for part in reversed(frames[1:])
                  if '\x1b[?2026l' in part), '')
    return re.sub(r'\s+', ' ', re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', frame))


def control(path):
    note('control', path=path, frame=normalized()[-32768:])
    with urllib.request.urlopen(control_url + path, timeout=12) as response:
        return json.load(response)


def receive(timeout=.05):
    global buffer
    if select.select([master], [], [], timeout)[0]:
        chunk = os.read(master, 65536)
        if not chunk:
            raise RuntimeError('owned_auth_pty_eof')
        buffer = (buffer + decoder.decode(chunk))[-1048576:]


def drain(deadline=None):
    reads = 0
    while select.select([master], [], [], 0)[0]:
        if reads >= 16:
            raise RuntimeError('owned_auth_drain_limit')
        if deadline is not None and time.monotonic() > deadline:
            raise RuntimeError('owned_auth_drain_deadline')
        receive(0)
        reads += 1


def wait(text, compact=False):
    deadline = time.monotonic() + 10
    while True:
        drain(deadline)
        current = normalized().replace(' ', '') if compact else normalized()
        if text in current:
            note('matched', text=text, frame=normalized()[-32768:])
            return
        if time.monotonic() > deadline:
            raise RuntimeError('owned_auth_frame_deadline:' + text)
        receive()


def wait_absent(text):
    deadline = time.monotonic() + 10
    while True:
        drain(deadline)
        if normalized() and text not in normalized():
            note('absent', text=text, frame=normalized()[-32768:])
            return
        if time.monotonic() > deadline:
            raise RuntimeError('owned_auth_absent_deadline:' + text)
        receive()


def key(value, retain=False):
    global buffer
    drain()
    note('key', hex=value.hex(), retain=retain, frame=normalized()[-32768:])
    if not retain:
        buffer = ''
    os.write(master, value)


def choose(label, top=None):
    deadline = time.monotonic() + 10
    for step in range(32):
        drain(deadline)
        frame = normalized().replace(' ', '')
        target = label.replace(' ', '')
        if '›' + target in frame:
            note('choice', label=label, frame=normalized()[-32768:])
            return
        selected_at = frame.find('›')
        target_at = frame.find(target)
        if selected_at < 0:
            raise RuntimeError('owned_auth_selection_absent')
        direction = (b'\x1b[B' if label.startswith('Original authentication:') else b'\x1b[A') if target_at < 0 else (b'\x1b[A' if target_at < selected_at else b'\x1b[B')
        key(direction)
        while not normalized():
            if time.monotonic() > deadline:
                raise RuntimeError('owned_auth_navigation_frame_deadline:' + label)
            receive()
    raise RuntimeError('owned_auth_choice_unavailable:' + label)


def start(phase):
    global process, master, buffer, decoder
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 0, 0))
    decoder = codecs.getincrementaldecoder('utf-8')('strict')
    process = subprocess.Popen([executable, host], stdin=slave, stdout=slave, stderr=slave,
                               start_new_session=True,
                               env=dict(os.environ, HOME=root, KITE_CODE_HOME=os.path.join(root, 'owned-home')))
    os.close(slave)
    buffer = ''
    with open(os.path.join(evidence, 'pty-owned.jsonl'), 'a') as ledger:
        ledger.write(json.dumps(dict(phase=phase, pid=process.pid)) + '\n')
        ledger.flush()
        os.fsync(ledger.fileno())
    wait('New Run >')


def auth(history=False):
    key(b'/mcp')
    wait('New Run > /mcp')
    key(b'\r')
    wait('Project sources')
    choose('Project sources', 'Project sources')
    key(b'\r')
    wait('Original authentication requests')
    wait_absent('Reading project sources')
    if history:
        choose('Original authentication requests', 'Original authentication requests')
    key(b'\r')
    if not history:
        wait('Authentication')
        choose('Authentication', 'Authentication')
        key(b'\r')
    wait('MCP authentication')
    wait_absent('Reading authentication')


def selected(command_id):
    wait('Originalauthentication:' + command_id + 'OriginalStore:' + store_id + '·Sessiona', True)


def leave(pending=False):
    key(b'\x03')
    wait('Project sources')
    key(b'\x03')
    wait('Ctrl+B pending cards' if pending else 'New Run >')


def close(phase):
    global master, process
    key(b'\x11')
    deadline = time.monotonic() + 6
    while process.poll() is None and time.monotonic() < deadline:
        if select.select([master], [], [], .05)[0]:
            try:
                os.read(master, 65536)
            except OSError:
                break
    process.wait(timeout=3)
    exits.append(dict(phase=phase, pid=process.pid, exitCode=process.returncode, normalCtrlQ=True))
    assert process.returncode == 0
    os.close(master)
    master = None
    process = None


try:
    start('warm')
    ids = []
    for n, label in enumerate(['Login', 'Refresh credentials', 'Revoke remote credentials', 'Login', 'Clear local credentials'], 1):
        auth()
        choose('Review ' + label, 'Review Login')
        key(b'\r')
        wait('Confirm authentication: ' + label)
        control('before-confirm/' + str(n))
        key(b'\r')
        wait('Original authentication:')
        leave(pending=True)
        actual = control('finish/' + str(n))
        ids.append(actual['commandId'])
        wait('builtin.mcp.sources/mcp.auth.' + ['login','refresh','revoke','login','clear'][n-1] + ' [' + actual['executionId'] + '] succeeded')
        wait('New Run >')
        auth()
        choose('Original authentication: ' + actual['commandId'], 'Review Login')
        key(b'\r', retain=True)
        selected(actual['commandId'])
        choose('Check original authentication', 'Review Login')
        key(b'\r')
        selected(actual['commandId'])
        wait('Credentials cleared' if n in [3,5] else 'Credentials saved; reconnect separately')
        leave()
    control('warm-complete')
    close('warm')
    control('cold-removed')
    start('cold-removed')
    auth(history=True)
    original = control('selection-baseline')['commandId']
    choose('Original authentication: ' + original, 'Original authentication: ' + ids[0])
    key(b'\r', retain=True)
    selected(original)
    control('cold-selected')
    choose('Check original authentication', 'Original authentication: ' + ids[0])
    key(b'\r')
    selected(original)
    wait('Credentials saved; reconnect separately')
    control('cold-lookup')
    leave()
    close('cold-removed')
    complete = True
    print('AUTH_WARM_COLD_COMPLETE', flush=True)
except BaseException as error:
    failure = repr(error)
    note('failure', message=failure, frame=normalized()[-32768:])
    raise
finally:
    if process is not None and process.poll() is None:
        os.kill(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=6)
        except subprocess.TimeoutExpired:
            os.kill(process.pid, signal.SIGKILL)
            process.wait(timeout=3)
        exits.append(dict(phase='failure', pid=process.pid, exitCode=process.returncode, normalCtrlQ=False))
    if master is not None:
        os.close(master)
    for basename, value in [('pty-trace.json', dict(failure=failure, latestCompleteFrame=normalized()[-32768:], trace=trace)),
                            ('pty-exits.json', dict(normalComplete=complete, exits=exits))]:
        path = os.path.join(evidence, basename)
        with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600), 'w') as receipt:
            json.dump(value, receipt)
            receipt.flush()
            os.fsync(receipt.fileno())
