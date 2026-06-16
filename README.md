# quickcloud-cli (`qc`)

A tiny, **zero-dependency** command-line tool for the QuickHost QuickCloud API
(https://quickcloud.uk). Manage your cloud VMs straight from your shell —
scriptable, pipeable, automatable.

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
qc templates ubuntu-24          # required inputs for one template

qc vm list
qc vm show 101
qc vm create --name web1 --vcpu 2 --ram 4 --disk 40 --os ubuntu-24 \
             --user ubuntu --password 'ChangeMe-123!' \
             --ssh-key "ssh-ed25519 AAAA…" \
             --user-data-file cloud-init.yml --wait
qc vm start|stop|shutdown|reboot 101
qc vm rename 101 web-prod
qc vm resize 101 --vcpu 4 --ram 8
qc vm wait 101                  # block until the VM is running (or --status stopped)
qc vm ssh 101 --user ubuntu     # SSH straight in using the VM's IP
qc vm delete 101 --yes

qc job wait 5567                # block until an async job finishes
```

**Private networks** (a backend tier — keep your DB off the public internet):

```sh
qc net create db-net --cidr 10.20.0.0/24
qc net list
qc net attach 101 db-net --ip 10.20.0.5      # hot-add a private NIC to a running VM
qc vm create --name db1 --os ubuntu-24 --vcpu 2 --ram 4 --disk 40 \
             --user ubuntu --password '…' --no-ip --priv-net 7   # backend-only, no public IP
qc net detach 101 1                          # remove interface index 1 (see `qc vm show`)
qc net rm db-net --yes
```


**Provision and connect in one go:**

```sh
qc vm create --name web1 --os ubuntu-24 --vcpu 2 --ram 4 --disk 40 \
             --user ubuntu --password 'ChangeMe-123!' --wait
qc vm ssh web1-id --user ubuntu
```

`--wait` blocks until the build job finishes and then prints the VM's IP.
`qc vm ssh` looks up the VM's IP and hands off to your local `ssh` — anything
after `--` is passed through (e.g. `qc vm ssh 101 -- -p 2222 uptime`).

**Creating a VM:**

- `--os` takes the template **name** — run `qc templates` and use the value in the
  `NAME` column (not the friendly label).
- Each template decides which inputs it needs. Many require a **username**
  (`--user`) and **password** (`--password`) as well as / instead of an
  `--ssh-key`. If you miss one, the error tells you exactly which:
  `error: … — ciuser is required, password is required` — just add that flag.
- Quote values containing spaces or symbols (passwords, SSH keys) so your shell
  passes them through intact.
- `--user-data-file` takes a path to a cloud-init document (a `#cloud-config`
  YAML or a script) that runs on the VM's **first boot** — use it to install and
  configure software unattended. Max 60 KB; not available for ISO installs. Treat
  the file as sensitive if it contains secrets.

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

## Tab completion

`qc` ships shell completion for commands, sub-commands and flags. Enable it by
adding one line to your shell's rc file:

```sh
# bash — in ~/.bashrc
eval "$(qc completion bash)"

# zsh — in ~/.zshrc
eval "$(qc completion zsh)"
```

Open a new shell, then `qc <Tab>`, `qc vm <Tab>`, `qc vm create --<Tab>`, etc.
(`qc` must be on your `PATH` for completion to work.)

## How it works

`qc` is a thin client over the QuickCloud **v1 REST API**. Every command maps to a
single API call authenticated with your key — which is scoped to your workspace
and role — so the CLI can only ever do what your key is permitted to do. The full
API (and an OpenAPI spec) is documented in your panel under **API**.

## License

[MIT](LICENSE).
