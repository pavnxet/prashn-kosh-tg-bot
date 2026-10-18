#!/usr/bin/env python3
"""
Rotate the Telegram BOT_TOKEN in this project's .env file.

Why this exists
---------------
After a token is revoked at @BotFather the new one has to land in .env without
being pasted into a chat, a shell history, or a log. This script reads it with a
hidden prompt, verifies it against Telegram, and writes only that one line.

Safety properties
-----------------
* The token is read with getpass(), so it is not echoed to the terminal.
* It is never printed, logged or written anywhere except the .env line itself.
  Only the non-secret bot id (the digits before ":") and the length are shown.
* The token is verified with the real getMe call BEFORE .env is touched, so a
  typo or a revoked token aborts the run and leaves the file untouched.
* .env is rewritten atomically (temp file + os.replace) with its original line
  endings and without a BOM, so a crash cannot leave a truncated file.
* Exceptions from urllib are never printed verbatim: their repr contains the
  request URL, which contains the token.

Usage
-----
    python3 set_bot_token.py                  # prompt, verify, write
    python3 set_bot_token.py --show-current   # print the current token, masked
    python3 set_bot_token.py --dry-run        # verify but write nothing
    python3 set_bot_token.py --no-verify      # skip getMe (offline)
    python3 set_bot_token.py --force          # allow a non-standard shape
    python3 set_bot_token.py --env-file ../other/.env
    python3 set_bot_token.py --restart-pm2 prashn-kosh-tg-bot

Note: getpass() needs a real console. If stdin is not a terminal (a pipe, cron,
pm2, CI) the script refuses to run instead of hanging, because on Windows
getpass blocks forever waiting on a console handle in that situation. For those
cases use --token-stdin, which reads one line from stdin.

Standard library only, Python 3.8+.
"""

import argparse
import getpass
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_ENV = HERE / ".env"

# 123456789:AAHfoo... — digits, a colon, then the secret half.
TOKEN_RE = re.compile(r"^[0-9]{5,15}:[A-Za-z0-9_-]{25,60}$")
KEY_RE = re.compile(r"^\s*(export\s+)?BOT_TOKEN\s*=")
API_URL = "https://api.telegram.org/bot{token}/getMe"


def mask(token: str) -> str:
    """Render a token so it can be shown safely: bot id visible, secret hidden."""
    if not token:
        return "<empty>"
    bot_id, sep, secret = token.partition(":")
    if not sep:
        return "{}... ({} chars, no colon)".format("*" * 6, len(token))
    return "{}:{} ({} chars)".format(bot_id, "*" * min(len(secret), 8), len(token))


def read_env(path: Path):
    """Return (text, eol, had_trailing_newline) or raise SystemExit."""
    if not path.is_file():
        sys.exit(
            "ERROR: {0} not found.\n"
            "Create it first:  cp .env.example .env   (or scp the project folder)".format(path)
        )
    raw = path.read_bytes()
    try:
        text = raw.decode("utf-8-sig")  # tolerate but never re-add a BOM
    except UnicodeDecodeError:
        sys.exit("ERROR: {0} is not valid UTF-8.".format(path))
    eol = "\r\n" if "\r\n" in text else "\n"
    return text.replace("\r\n", "\n"), eol


def current_token(path: Path) -> str:
    text, _ = read_env(path)
    for line in text.split("\n"):
        if KEY_RE.match(line):
            return line.split("=", 1)[1].strip().strip("\"'")
    return ""


def verify(token: str):
    """Call getMe. Returns (ok, description, username, bot_id). Never leaks the token."""
    req = urllib.request.Request(API_URL.format(token=token), method="GET")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            payload = json.load(resp)
    except urllib.error.HTTPError as exc:
        # exc.repr / str(exc) contain the URL, i.e. the token. Read only the body.
        description = ""
        try:
            body = json.loads(exc.read().decode("utf-8", "replace"))
            description = str(body.get("description", ""))
        except Exception:
            pass
        if exc.code == 401:
            return False, "Telegram rejected it (401 Unauthorized){}".format(
                ": " + description if description else ""
            ), None, None
        return False, "Telegram returned HTTP {0}{1}".format(
            exc.code, ": " + description if description else ""
        ), None, None
    except urllib.error.URLError as exc:
        return False, "network error ({0})".format(type(exc.reason).__name__), None, None
    except Exception as exc:  # noqa: BLE001 - never surface the URL
        return False, "unexpected {0}".format(type(exc).__name__), None, None

    if not payload.get("ok"):
        return False, "Telegram said ok:false ({0})".format(payload.get("description", "?")), None, None
    result = payload.get("result", {})
    return True, "verified", result.get("username"), result.get("id")


def write_token(path: Path, text: str, eol: str, token: str) -> bool:
    """Replace (or append) the BOT_TOKEN line. Returns True if the file changed."""
    lines = text.split("\n")
    replaced = False
    for index, line in enumerate(lines):
        if KEY_RE.match(line):
            prefix = "export " if line.lstrip().startswith("export ") else ""
            new_line = "{0}BOT_TOKEN={1}".format(prefix, token)
            if line == new_line:
                return False
            lines[index] = new_line
            replaced = True
            break
    if not replaced:
        lines.append("BOT_TOKEN={0}".format(token))

    data = eol.join(lines).encode("utf-8")  # no BOM
    tmp = path.with_name(path.name + ".tmp")
    try:
        tmp.write_bytes(data)
        os.replace(tmp, path)
    finally:
        if tmp.exists():
            try:
                tmp.unlink()
            except OSError:
                pass
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass  # Windows / filesystems without POSIX modes
    return True


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Rotate the Telegram BOT_TOKEN in .env (never prints the secret)."
    )
    parser.add_argument("--env-file", default=str(DEFAULT_ENV), help="path to .env")
    parser.add_argument("--show-current", action="store_true", help="print the current token, masked, and exit")
    parser.add_argument("--dry-run", action="store_true", help="verify but do not write")
    parser.add_argument("--no-verify", action="store_true", help="skip the Telegram getMe check")
    parser.add_argument("--force", action="store_true", help="accept a token that is not <digits>:<secret>")
    parser.add_argument(
        "--token-stdin",
        action="store_true",
        help="read the token from stdin instead of the hidden prompt (for automation; mind your shell history)",
    )
    parser.add_argument("--restart-pm2", metavar="NAME", help="pm2 restart NAME after a successful write")
    args = parser.parse_args()

    env_path = Path(args.env_file).expanduser().resolve()

    if args.show_current:
        text, _ = read_env(env_path)
        token = current_token(env_path)
        print("file:   {0}".format(env_path))
        print("BOT_TOKEN: {0}".format(mask(token)))
        if not text.strip():
            print("(the file has no usable lines)")
        return 0

    print("file: {0}".format(env_path))
    print("current BOT_TOKEN: {0}".format(mask(current_token(env_path))))

    if args.token_stdin:
        token = sys.stdin.readline().strip()
        if not token:
            print("ERROR: --token-stdin was given but stdin was empty.")
            return 1
    elif not sys.stdin.isatty():
        print(
            "ERROR: no interactive terminal on stdin, so the hidden prompt cannot work.\n"
            "Run this in a real terminal, or pipe the token in:\n"
            "  printf '%s\\n' \"$NEW_BOT_TOKEN\" | python3 set_bot_token.py --token-stdin"
        )
        return 1
    else:
        try:
            token = getpass.getpass("Paste the NEW BOT_TOKEN (hidden, not echoed): ").strip()
        except (KeyboardInterrupt, EOFError):
            print("\nAborted.")
            return 1

    if not token:
        print("ERROR: nothing was entered.")
        return 1
    if token != token.strip() or any(ch.isspace() for ch in token):
        print("ERROR: the value contains whitespace. Paste only the token.")
        return 1
    if not TOKEN_RE.match(token):
        print(
            "WARNING: that does not look like a Telegram token (expected "
            "<digits>:<secret>). Check the paste."
        )
        if not args.force:
            print("Re-run with --force if you are certain.")
            return 1

    if not args.no_verify:
        print("asking Telegram to verify it ...")
        ok, note, username, bot_id = verify(token)
        if not ok:
            print("FAILED: {0}".format(note))
            print("{0} was NOT modified.".format(env_path.name))
            return 1
        print("OK: @{0} (id {1})".format(username, bot_id))
        print("Confirm that is the bot you meant.")
    else:
        print("skipping verification (--no-verify)")

    text, eol = read_env(env_path)
    if args.dry_run:
        print("dry run: would set BOT_TOKEN={0} in {1}".format(mask(token), env_path.name))
        return 0

    if write_token(env_path, text, eol, token):
        print("WROTE BOT_TOKEN={0} to {1}".format(mask(token), env_path))
    else:
        print("no change: {0} already had that exact value".format(env_path.name))

    if args.restart_pm2:
        print("restarting pm2 app {0} ...".format(args.restart_pm2))
        try:
            subprocess.run(["pm2", "restart", args.restart_pm2], check=False)
        except FileNotFoundError:
            print("WARNING: pm2 not found on this machine; restart the bot yourself.")
    else:
        print("Now restart the bot so it re-reads .env:")
        print("  local     : node src/index.js")
        print("  J7 (pm2)  : pm2 restart prashn-kosh-tg-bot")
        print("Then confirm:  npm run check   # expect telegram_ok")

    return 0


if __name__ == "__main__":
    sys.exit(main())
