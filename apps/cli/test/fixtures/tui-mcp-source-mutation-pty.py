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


def current_frame():
    frames = buffer.split('\x1b[?2026h')
    frame = next((part.split('\x1b[?2026l')[0] for part in reversed(frames[1:])
                  if '\x1b[?2026l' in part), '')
    return re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', frame)


def normalized():
    return re.sub(r'\s+', ' ', current_frame())


def selected_label():
    return next((line.strip()[2:] for line in current_frame().splitlines()
                 if line.strip().startswith('› ')), None)


def control(path):
    note('control', path=path, frame=normalized()[-32768:])
    with urllib.request.urlopen(control_url + path, timeout=12) as response:
        return json.load(response)


def receive(timeout=.05):
    global buffer
    if select.select([master], [], [], timeout)[0]:
        chunk = os.read(master, 65536)
        if not chunk:
            raise RuntimeError('owned_source_mutation_pty_eof')
        buffer = (buffer + decoder.decode(chunk))[-1048576:]


def drain(deadline=None):
    reads = 0
    while select.select([master], [], [], 0)[0]:
        if reads >= 16:
            raise RuntimeError('owned_source_mutation_drain_limit')
        if deadline is not None and time.monotonic() > deadline:
            raise RuntimeError('owned_source_mutation_drain_deadline')
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
            raise RuntimeError('owned_source_mutation_frame_deadline:' + text)
        receive()


def wait_absent(text):
    deadline = time.monotonic() + 10
    while True:
        drain(deadline)
        if normalized() and text not in normalized():
            note('absent', text=text, frame=normalized()[-32768:])
            return
        if time.monotonic() > deadline:
            raise RuntimeError('owned_source_mutation_absent_deadline:' + text)
        receive()


def key(value, retain=False):
    global buffer
    drain()
    note('key', hex=value.hex(), retain=retain, frame=normalized()[-32768:])
    if not retain:
        buffer = ''
    os.write(master, value)


def choose(label, top='Add source entry'):
    deadline = time.monotonic() + 10
    if ('› ' + label) in normalized():
        return
    if ('› ' + top) not in normalized():
        key(b'\x1b[A' * 64)
        while ('› ' + top) not in normalized():
            drain(deadline)
            if time.monotonic() > deadline:
                raise RuntimeError('owned_source_mutation_top_deadline:' + top)
            receive()
    while True:
        drain(deadline)
        if ('› ' + label) in normalized():
            return
        if time.monotonic() > deadline:
            raise RuntimeError('owned_source_mutation_navigation_deadline:' + label)
        previous = selected_label()
        key(b'\x1b[B')
        while True:
            drain(deadline)
            selected = selected_label()
            if selected is not None and selected != previous:
                break
            if time.monotonic() > deadline:
                raise RuntimeError('owned_source_mutation_navigation_frame_deadline:' + label)
            receive()


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


def changes():
    key(b'/mcp')
    wait('New Run > /mcp')
    key(b'\r')
    wait('Project sources')
    choose('Source entry changes', 'Project sources')
    key(b'\r')
    wait('Add source entry')
    wait_absent('Reading source entry facts')


def selected(command_id):
    wait('Originalsourcechange:' + command_id + 'OriginalStore:' + store_id + '·Sessiona', True)


def select_original(command_id):
    choose('Original source change: ' + command_id)
    known = ('Originalsourcechange:' + command_id + 'OriginalStore:' + store_id + '·Sessiona') in normalized().replace(' ', '')
    key(b'\r', retain=known)
    selected(command_id)


def leave(parent='MCP · w', pending=False):
    key(b'\x03')
    wait(parent)
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
    changes()
    choose('Add source entry')
    key(b'\r')
    wait('Source entry name:')
    key(b'\r')
    wait('Invalid source entry name')
    control('empty-name')
    for character in b'shared':
        key(bytes([character]))
        wait('Source entry name:')
    key(b'\r')
    wait('› HTTP')
    key(b'\r')
    wait('Source entry value:')
    key(b'https://controlled.invalid/project')
    wait('https://controlled.invalid/project')
    key(b'\r')
    wait('› Current project')
    key(b'\r')
    wait('Review source entry change')
    control('add-review')
    key(b'\r')
    wait('Confirm source entry change')
    control('add-confirm')
    key(b'\r')
    wait('Original source change:')
    leave(pending=True)
    added_fact = control('approve-add')
    added = added_fact['commandId']
    wait('builtin.mcp.sources/mcp.source.add [' + added_fact['executionId'] + '] succeeded')
    wait('New Run >')
    changes()
    select_original(added)
    choose('Check original source change')
    key(b'\r')
    selected(added)
    wait('saved')
    choose('Remove source entry: shared · workspace')
    key(b'\r')
    wait('Review source entry change')
    wait('Removal reveals user source: shared')
    control('remove-review')
    key(b'\r')
    wait('Confirm source entry change')
    wait('Removal reveals user source: shared')
    control('remove-confirm')
    key(b'\r')
    wait('Original source change:')
    leave(pending=True)
    removed_fact = control('approve-remove')
    removed = removed_fact['commandId']
    wait('builtin.mcp.sources/mcp.source.remove [' + removed_fact['executionId'] + '] succeeded')
    wait('New Run >')
    changes()
    select_original(removed)
    choose('Check original source change')
    key(b'\r')
    selected(removed)
    wait('saved')
    control('warm-complete')
    leave()
    close('warm')

    control('cold-removed')
    start('cold-removed')
    changes()
    control('selection-baseline')
    select_original(removed)
    control('cold-selected')
    choose('Check original source change')
    key(b'\r')
    selected(removed)
    wait('saved')
    control('cold-lookup')
    leave('MCP · unavailable')
    close('cold-removed')

    control('cold-foreign')
    start('cold-foreign')
    changes()
    control('selection-baseline')
    select_original(removed)
    control('foreign-selected')
    choose('Check original source change')
    key(b'\r', retain=True)
    selected(removed)
    wait('outcome_unknown')
    control('foreign-lookup')
    leave('MCP · unavailable')
    close('cold-foreign')
    complete = True
    print('SOURCE_MUTATION_WARM_COLD_FOREIGN_COMPLETE', flush=True)
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
