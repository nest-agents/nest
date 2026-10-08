#!/usr/bin/env bash
# Act 5: an outside agent (Codex on this laptop) joins Nest through MCP as the participant the UI just
# invited. Recorded with asciinema; tokens are scrubbed from the cast before it is rendered.
#
# Codex runs here with approvals and its sandbox off, so that its git clone and push reach the network
# without a prompt on camera. That means everything it reads through MCP (task briefs, context, the fork)
# can steer a process with full access to this machine. Run it only against a Nest whose content you wrote,
# in a throwaway directory, as it was here; it is a recording aid, not part of the product.
set -euo pipefail
DIR=${VIDEO_DIR:-$(pwd)}
TOK=$(cat "$DIR/act5.token")
rm -rf "$DIR/act5-work" && mkdir -p "$DIR/act5-work" && cd "$DIR/act5-work"
export NEST_ACT5_TOKEN="$TOK"
export PROMPT='You are an outside agent joining Nest (where humans and agents build software together) through its MCP server, configured as "nest". Do this, in order, using the nest tools and plain git:
1. nest_objectives, then nest_state for objective "beacon-open"; find the open task t_feed-docs.
2. nest_claim objective "beacon-open", task "t_feed-docs". It returns a git remote and a short-lived token for your own fork.
3. Clone that remote into ./repo with: git -c http.extraHeader="Authorization: Bearer <that token>" clone <remote> repo
4. nest_pack for the task; read the requirement req/incident-feed in it.
5. In repo, add a README section documenting /incidents.atom (what it is, that readers may poll it every minute, one example entry). Change nothing else.
6. Commit as "Codex (laptop) <codex-laptop@agents.nest.invalid>" with a message whose last paragraph holds the trailers nest_claim told you to use (Nest-Attempt, and Nest-Cites: req/incident-feed@v2), then push to main with the same extraHeader.
7. nest_publish with the repo name and the commit sha. Then stop and say in two lines what you published.'
# Only the nest server for this session; the others in this laptop's config are not part of the story.
OFF=""
for s in $(codex mcp list 2>/dev/null | awk 'NR>1 && $1!="" {print $1}' | grep -vE "^(Name|nest)$"); do OFF="$OFF -c mcp_servers.\"$s\".enabled=false"; done
export COLUMNS=120 LINES=36
asciinema rec --overwrite --cols 120 --rows 36 --idle-time-limit 3 -c "codex exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check --model gpt-6-luna -c model_reasoning_effort=medium -c suppress_unstable_features_warning=true -c mcp_servers.nest.bearer_token_env_var=\"NEST_ACT5_TOKEN\" -c 'mcp_servers.nest.http_headers={Authorization=\"Bearer $TOK\"}' \"\$PROMPT\"" "$DIR/act5.cast"
# Scrub secrets and this laptop's hook chatter before rendering.
python3 -I - "$DIR/act5.cast" "$TOK" <<'PY'
import json, re, sys
p, tok = sys.argv[1], sys.argv[2]
lines = open(p, encoding="utf-8").read().splitlines()
out = [lines[0]]
for l in lines[1:]:
    try: t, kind, data = json.loads(l)
    except Exception: continue
    if kind == "o":
        data = data.replace(tok, "<participant token>")
        data = re.sub(r'Bearer [A-Za-z0-9._-]{30,}', 'Bearer <token>', data)
        data = re.sub(r'"token":\s*"[^"]{20,}"', '"token": "<token>"', data)
        data = re.sub(r'(ghs_|gho_|github_pat_)[A-Za-z0-9_]{20,}', r'\1<token>', data)
        data = re.sub(r'\b[a-z][a-z0-9-]*\.[0-9a-f]{8}\.t_[a-z0-9-]+\.\d+\.[0-9a-f]{64}\b', '<task token>', data)
        data = re.sub(r'\bp\.[a-z][a-z0-9-]*\.\d+\.[0-9a-f]{64}\b', '<participant token>', data)
        if re.match(r'^(hook: |warning: )', data.strip()) or 'rmcp::transport::worker' in data: continue
    out.append(json.dumps([t, kind, data]))
open(p, "w", encoding="utf-8").write("\n".join(out) + "\n")
PY
agg --cols 120 --rows 36 --font-size 20 --theme asciinema --speed 1.0 "$DIR/act5.cast" "$DIR/act5.gif"
ffmpeg -y -loglevel error -i "$DIR/act5.gif" -vf "scale=1600:900:force_original_aspect_ratio=decrease:flags=lanczos,pad=1600:900:(ow-iw)/2:(oh-ih)/2:color=#111316,fps=30,format=yuv420p" "$DIR/act5.mp4"
ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$DIR/act5.mp4"
echo "act5 done: $DIR/act5.mp4"
