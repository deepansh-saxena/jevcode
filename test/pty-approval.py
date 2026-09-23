"""Exercise CLI approval or offline account login through a real PTY."""

import errno
import fcntl
import json
import os
import pty
import select
import signal
import subprocess
import struct
import sys
import time
import termios


def interrupted(signum, frame):
    raise KeyboardInterrupt


signal.signal(signal.SIGTERM, interrupted)
master, slave = pty.openpty()
fcntl.ioctl(
    slave, termios.TIOCSWINSZ,
    struct.pack("HHHH", 24, int(os.environ.get("JEV_PTY_COLUMNS", "80")), 0, 0),
)
child = subprocess.Popen(sys.argv[1:], stdin=slave, stdout=slave, stderr=slave)
os.close(slave)
output = b""
scenarios = {
    "login": [(b"Continue? [yes/no]", b"yes\n"), (b"GitHub Enterprise URL/domain", b"\n")],
    "terminal-prompts": [
        (b"Confirm long prompt? [yes/no]", b"yes\n"),
        (b"Paste the test login value (input hidden):", b"SYNTHETIC_HIDDEN_INPUT\n"),
    ],
}
prompts = scenarios.get(
    os.environ.get("JEV_PTY_SCENARIO"),
    [(b"Type yes to execute this exact action:", b"yes\n")],
)
if "JEV_PTY_PROMPTS" in os.environ:
    prompts = [(prompt.encode(), answer.encode()) for prompt, answer in json.loads(os.environ["JEV_PTY_PROMPTS"])]
answered = 0
answered_at = 0
deadline = time.monotonic() + 15
try:
    while time.monotonic() < deadline:
        if not select.select([master], [], [], 0.05)[0]:
            if child.poll() is not None:
                break
            # Wait for redraws to settle before responding to a visible prompt.
            visible_tail = output[answered_at:].rsplit(b"\x1b[0J", 1)[-1]
            if answered < len(prompts) and prompts[answered][0] in visible_tail:
                if answered == 0 and "JEV_PTY_RESIZE" in os.environ:
                    rows, columns = json.loads(os.environ["JEV_PTY_RESIZE"])
                    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))
                    os.kill(child.pid, signal.SIGWINCH)
                os.write(master, prompts[answered][1])
                answered += 1
                answered_at = len(output)
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
    child.wait(timeout=max(0.1, deadline - time.monotonic()))
    if answered != len(prompts):
        raise RuntimeError("CLI did not complete the expected prompts")
    sys.exit(child.returncode)
finally:
    if child.poll() is None:
        child.kill()
        child.wait()
    os.close(master)
