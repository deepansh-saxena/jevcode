"""Exercise CLI approval or offline account login through a real PTY."""

import errno
import os
import pty
import select
import signal
import subprocess
import sys
import time


def interrupted(signum, frame):
    raise KeyboardInterrupt


signal.signal(signal.SIGTERM, interrupted)
master, slave = pty.openpty()
child = subprocess.Popen(sys.argv[1:], stdin=slave, stdout=slave, stderr=slave)
os.close(slave)
output = b""
prompts = (
    [(b"Continue? [yes/no]", b"yes\n"), (b"GitHub Enterprise URL/domain", b"\n")]
    if os.environ.get("JEV_PTY_SCENARIO") == "login"
    else [(b"Type yes to execute this exact action:", b"yes\n")]
)
answered = 0
deadline = time.monotonic() + 8
try:
    while time.monotonic() < deadline:
        if not select.select([master], [], [], 0.1)[0]:
            if child.poll() is not None:
                break
            continue
        try:
            chunk = os.read(master, 65536)
        except OSError as error:
            if error.errno == errno.EIO:
                break
            raise
        if not chunk:
            break
        output += chunk
        sys.stdout.buffer.write(chunk)
        sys.stdout.buffer.flush()
        if answered < len(prompts) and prompts[answered][0] in output:
            os.write(master, prompts[answered][1])
            answered += 1
    child.wait(timeout=max(0.1, deadline - time.monotonic()))
    if answered != len(prompts):
        raise RuntimeError("CLI did not complete the expected prompts")
    sys.exit(child.returncode)
finally:
    if child.poll() is None:
        child.kill()
        child.wait()
    os.close(master)
