"""SSH/SCP runner — shells out to system `ssh`/`scp` to avoid a paramiko dep.

We assume the user's system has the SSH key matching their Lambda-registered key
loaded in the agent or available as a default identity (~/.ssh/id_*). For tighter
control set LambdaConfig.ssh_private_key.
"""

from __future__ import annotations

import logging
import shlex
import subprocess
import time
from pathlib import Path
from typing import Iterable, Optional, Sequence

log = logging.getLogger(__name__)


class SshRunner:
    def __init__(
        self,
        host: str,
        user: str = "ubuntu",
        identity_file: Optional[str] = None,
        connect_timeout: int = 10,
    ):
        self.host = host
        self.user = user
        self.identity_file = identity_file
        self.connect_timeout = connect_timeout

    # ---- raw helpers -----------------------------------------------------
    def _ssh_args(self) -> list[str]:
        args = [
            "-o", "StrictHostKeyChecking=accept-new",
            "-o", "UserKnownHostsFile=/dev/null",
            "-o", "LogLevel=ERROR",
            "-o", f"ConnectTimeout={self.connect_timeout}",
            "-o", "ServerAliveInterval=15",
            # Tolerate up to 30 minutes of silence — gsplat first-import
            # builds CUDA kernels with no stdout for 5–10 min on a fresh box.
            "-o", "ServerAliveCountMax=120",
            "-o", "TCPKeepAlive=yes",
        ]
        if self.identity_file:
            args.extend(["-i", self.identity_file, "-o", "IdentitiesOnly=yes"])
        return args

    def wait_for_ssh(self, *, timeout: float = 300.0, interval: float = 5.0) -> None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                self.run("true", check=True, capture=True, log_command=False)
                log.info("ssh up on %s", self.host)
                return
            except subprocess.CalledProcessError:
                time.sleep(interval)
        raise TimeoutError(f"ssh never came up on {self.host} within {timeout}s")

    def run(
        self,
        command: str,
        *,
        check: bool = True,
        capture: bool = False,
        env: Optional[dict[str, str]] = None,
        log_command: bool = True,
    ) -> subprocess.CompletedProcess:
        if env:
            prefix = " ".join(f"{k}={shlex.quote(v)}" for k, v in env.items())
            command = f"{prefix} {command}"
        argv = ["ssh", *self._ssh_args(), f"{self.user}@{self.host}", command]
        if log_command:
            log.info("ssh> %s", command)
        return subprocess.run(
            argv,
            check=check,
            text=True,
            capture_output=capture,
        )

    def run_streaming(self, command: str) -> int:
        """Run a long command, streaming both stdout and stderr to our logger."""
        argv = ["ssh", *self._ssh_args(), f"{self.user}@{self.host}", command]
        log.info("ssh> %s", command)
        proc = subprocess.Popen(
            argv,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
        assert proc.stdout is not None
        for line in proc.stdout:
            log.info("[remote] %s", line.rstrip())
        return proc.wait()

    def run_detached(
        self,
        command: str,
        *,
        log_path: str,
        pid_path: str,
        done_path: str,
        poll_interval: float = 8.0,
        max_silence: float = 1800.0,
        display_command: Optional[str] = None,
    ) -> int:
        """Run a long-running command on the remote, detached from this SSH session.

        The command writes to `log_path`, its PID to `pid_path`, and creates `done_path`
        (containing the exit code) when it finishes. We tail the log and poll for the
        done marker, so a dropped SSH connection just means we reconnect on next poll.
        """
        # `setsid` + nohup + redirected fds = orphaned process that survives our SSH death.
        wrapped = (
            f"rm -f {pid_path!r} {done_path!r}; "
            f"setsid bash -c {shlex.quote(command + f' > {log_path} 2>&1; echo $? > {done_path}')} "
            f"</dev/null >/dev/null 2>&1 & echo $! > {pid_path}; "
            f"disown; sleep 1"
        )
        log.info("detach> %s", display_command or command)
        # Single short SSH call to spawn it. Any TCP wobble after this is harmless.
        self.run(wrapped, check=True, log_command=False)

        offset = 0
        last_progress = time.monotonic()
        while True:
            try:
                # Tail any new bytes from the log file.
                cp = subprocess.run(
                    ["ssh", *self._ssh_args(), f"{self.user}@{self.host}",
                     f"if [ -f {log_path} ]; then "
                     f"tail -c +{offset + 1} {log_path}; "
                     f"wc -c < {log_path}; fi; "
                     f"if [ -f {done_path} ]; then echo __DONE__; cat {done_path}; fi"],
                    capture_output=True, text=True, timeout=60,
                )
                out = cp.stdout
            except (subprocess.TimeoutExpired, subprocess.CalledProcessError) as e:
                log.warning("poll ssh hiccup, will retry: %s", e)
                time.sleep(poll_interval)
                if time.monotonic() - last_progress > max_silence:
                    raise TimeoutError(
                        f"no remote progress in {max_silence}s; aborting"
                    )
                continue

            done_idx = out.find("__DONE__")
            new_bytes_text: str
            if done_idx >= 0:
                tail_block = out[:done_idx].rstrip()
                # Last line before __DONE__ marker is wc -c output (total log bytes).
                lines = tail_block.split("\n")
                size_line = lines[-1] if lines else "0"
                new_bytes_text = "\n".join(lines[:-1])
                done_text = out[done_idx + len("__DONE__"):].strip().split("\n")[0]
                exit_code = int(done_text or "0")
                for line in new_bytes_text.split("\n"):
                    if line:
                        log.info("[remote] %s", line)
                log.info("[detached] exit=%d (log=%s)", exit_code, log_path)
                return exit_code

            # Not done yet. Output is: <new_bytes>\n<size>
            stripped = out.rstrip()
            if stripped:
                lines = stripped.split("\n")
                try:
                    new_size = int(lines[-1])
                except ValueError:
                    new_size = offset
                new_bytes_text = "\n".join(lines[:-1])
                if new_bytes_text:
                    last_progress = time.monotonic()
                    for line in new_bytes_text.split("\n"):
                        if line:
                            log.info("[remote] %s", line)
                offset = new_size
            if time.monotonic() - last_progress > max_silence:
                raise TimeoutError(f"no remote progress in {max_silence}s; aborting")
            time.sleep(poll_interval)

    def upload(self, local: Path, remote: str, *, recursive: bool = False) -> None:
        argv = ["scp", *self._ssh_args()]
        if recursive:
            argv.append("-r")
        argv.extend([str(local), f"{self.user}@{self.host}:{remote}"])
        log.info("scp> %s -> %s", local, remote)
        subprocess.run(argv, check=True)

    def download(self, remote: str, local: Path, *, recursive: bool = False) -> None:
        argv = ["scp", *self._ssh_args()]
        if recursive:
            argv.append("-r")
        argv.extend([f"{self.user}@{self.host}:{remote}", str(local)])
        log.info("scp< %s -> %s", remote, local)
        subprocess.run(argv, check=True)
