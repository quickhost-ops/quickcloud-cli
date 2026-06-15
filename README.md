# quickcloud-cli (`qc`)

A tiny, **zero-dependency** command-line tool for the QuickCloud API. Manage your
cloud VMs straight from your shell — scriptable, pipeable, automatable.

> **Read before you run.** `qc` is a single, self-contained file. It has no
> dependencies and contains **no secrets** — it reads your API key from *your own*
> machine (`~/.config/quickcloud/config.json` or an env var) and never embeds it.

## Install

Requires **Node.js 18+**. It's a single file — feel free to read [`qc.mjs`](qc.mjs)
first, then:

```sh
curl -fsSL https://raw.githubusercontent.com/quickhost-ops/quickcloud-cli/main/qc.mjs -o qc && chmod +x qc
sudo mv qc /usr/local/bin/        # optional: put it on your PATH
```

> **Shortcut:** if your provider's panel offers a "Download qc" button, that copy
> comes **pre-filled with the panel URL**, so you can skip `qc config set url`
> below. The copy here defaults to `cloud.quickhost.uk` — set your own URL if your
> provider uses a different domain.

## Configure

Create an API key in the panel under **API**, then:

```sh
qc config set token qck_xxxxxxxxxxxx
qc config set url   https://cloud.quickhost.uk   # or your provider's panel URL
```

Config lives in `~/.config/quickcloud/config.json` (chmod 600). You can also use
the `QC_API_TOKEN` and `QC_API_URL` environment variables, which take precedence.

## Usage

```sh
qc whoami                       # workspace, billing & quota
qc templates                    # OS templates you can launch from

qc vm list
qc vm show 101
qc vm create --name web1 --vcpu 2 --ram 4 --disk 40 --os ubuntu-24 \
             --ssh-key "ssh-ed25519 AAAA…"
qc vm start|stop|shutdown|reboot 101
qc vm rename 101 web-prod
qc vm resize 101 --vcpu 4 --ram 8
qc vm delete 101 --yes

qc job wait 5567                # block until an async job finishes
```

Add `--json` to any command for machine-readable output:

```sh
qc vm list --json | jq -r '.vms[] | "\(.id)\t\(.name)\t\(.status)"'
```

Reseller keys can manage customer workspaces too:

```sh
qc reseller customers list
qc reseller customers create --label "Acme Ltd" --ext-ref 30960 \
             --vcpu 4 --ram 8 --disk 80
```

Run `qc help` for the full command list.

## How it works

`qc` is a thin client over the QuickCloud **v1 REST API**. Every command maps to a
single API call authenticated with your key — which is scoped to your workspace
and role — so the CLI can only ever do what your key is permitted to do. The full
API (and an OpenAPI spec) is documented in your panel under **API**.

## License

[MIT](LICENSE).
