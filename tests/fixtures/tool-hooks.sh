#!/bin/sh
# Deterministic native-sandbox fixture: one JSON line in, one JSON document out.
set -eu
IFS= read -r payload
case "$1" in
  echo)
    case "$payload" in *'"value":"ok"'*) ;; *) exit 3 ;; esac
    printf '%s\n' '{"success":true,"contentItems":[{"type":"inputText","text":"echo ok"}],"structuredContent":{"echo":"ok"}}'
    ;;
  failure)
    printf '%s\n' '{"success":false,"contentItems":[{"type":"inputText","text":"expected failure"}]}'
    ;;
  pre)
    case "$payload" in
      *'"path":"blocked"'*) printf '%s\n' '{"decision":"block","reason":"fixture policy"}' ;;
      *'"path":"rewrite-invalid"'*) printf '%s\n' '{"updatedArguments":{"path":3}}' ;;
      *'"path":"conflict-to-create"'*) printf '%s\n' '{"updatedArguments":{"path":"conflict-target","text":"changed","expectedSha256":null}}' ;;
      *'"path":"conflict-to-replace"'*) printf '%s\n' '{"updatedArguments":{"path":"conflict-target","text":"changed","expectedSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}' ;;
      *'"path":"rewrite"'*) printf '%s\n' '{"updatedArguments":{"path":"rewritten","text":"hook changed this","expectedSha256":null}}' ;;
      *) printf '{}\n' ;;
    esac
    ;;
  post)
    case "$payload" in
      *'"path":"post-fail"'*) exit 2 ;;
      *'"path":"post-crash"'*) printf '%s' "$$" > hook-leader; printf marker >> hook-count; exec /bin/sleep 60 ;;
    esac
    printf '%s\n' "$payload" >> hook-events
    printf '{}\n'
    ;;
  *) exit 4 ;;
esac
