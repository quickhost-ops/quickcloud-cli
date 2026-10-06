# quickcloud-cli (`qc`)

A tiny, **zero-dependency** command-line tool for the QuickHost QuickCloud API
(https://quickcloud.uk). Manage your cloud VMs, dedicated servers, Cloud Firewalls, load balancers, storage boxes, managed databases and DNS straight from your shell —
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

**Cloud-init presets** (save your bootstrap document once — RMM agent, monitoring,
hardening — and apply it to every new VM with one flag):

```sh
qc preset save deploy --file cloud-init.yml   # or:  cat cloud-init.yml | qc preset save deploy
qc preset list
qc vm create --name web02 --os ubuntu-24 --vcpu 2 --ram 4 --disk 40 \
             --user ubuntu --password '…' --preset deploy --wait
qc preset show deploy > cloud-init.yml        # round-trip it back out
qc preset rm old-deploy --yes
```

`--preset` and `--user-data-file` are mutually exclusive — the preset *is* the
user-data, stored in your workspace and resolved server-side at create time.

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

**Snapshots** (point-in-time, retention-bounded) **and backups** (durable, off-storage):

```sh
qc snap create 101 pre-upgrade               # disk-only; add --ram on a running VM
qc snap list 101
qc snap rollback 101 88 --yes                # reverts — discards changes since the snapshot
qc snap rm 101 88

qc backup create 101 --note nightly
qc backup list 101                           # shows the volid you restore/delete by
qc backup restore 101 'PBS1:backup/…' --yes  # in-place; overwrites the VM's disks
qc backup rm 101 'PBS1:backup/…' --yes
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
- `--preset <name>` applies a **saved** cloud-init preset instead (see
  `qc preset` above) — same rules as `--user-data-file`, but the document lives
  in your workspace so every deploy uses the same, current copy.

**Dedicated servers** (bare metal by the hour — browse stock, buy, install, power,
rescue, IPs and RAID, all from the shell):

```sh
qc dedi stock                                 # what's for sale, £/h, OS choices
qc dedi buy 57 --os debian-13 --hostname box1 \
            --user deploy --ssh-key-file ~/.ssh/id_ed25519.pub --yes
                                              # charges the minimum rental now; installs straight away
qc dedi list
qc dedi show 57                               # hardware, power, IPs, armed boot, RAID
qc dedi reinstall 57 --os ubuntu-24.04 --hostname box1 --user deploy --password '…' --boot --yes
qc dedi off 57 --wait                         # chassis power via the management controller
qc dedi on 57
qc dedi rescue 57 --yes                       # boot SystemRescue (one-time root password printed)
qc dedi netboot 57 --yes                      # boot the netboot.xyz menu
qc dedi disarm 57                             # cancel an armed PXE boot
qc dedi ips 57 add                            # another IPv4 from the pool (account-wide quota)
qc dedi ips 57 rm 901 --yes
qc dedi storage 57 discover && qc dedi storage 57 show
qc dedi storage 57 apply --file raid.json --yes   # {"controller":"…","arrays":[{"level":"RAID1","disks":["…","…"]}]}
qc dedi bandwidth 57 --hours 168
qc dedi release 57 --yes                      # hand it back: wiped, billing stops
```

Buying and releasing send an `Idempotency-Key`, so a retried command never
buys (or releases) twice. The credit terms must be accepted once in the panel
before the API can commit credit. Passwords generated by an install or a rescue
boot are printed **once** and are not retrievable later.

**Cloud Firewall** (a managed OPNsense appliance, or HA pair, in front of your
servers - rules, port forwards, VPN users, networks, 1:1 NAT, site-to-site tunnels):

```sh
qc fw sizes                                   # sizes, prices, limits
qc fw create --label edge --size small --lan 10.90.0.0/24 --yes
                                              # appliance admin password printed ONCE
qc fw show 7
qc fw rules 7 add --port 443 --label https
qc fw rules 7 add --port 22 --from 198.51.100.0/24 --label "ssh from office"
qc fw rules 7 add --proto any --block --from 203.0.113.0/24 --label "block scanner"
qc fw forwards 7 add --port 2222 --to 10.90.0.10:22
qc fw lans 7 attach 11 101                    # put VM 101 on LAN 11 (keeps its public IP)
qc fw lans 7 private-only 11 101 --yes        # …then drop its public IP: internet via the firewall
qc fw wan 7 add                               # another public address
qc fw nat1 7 add --to 10.90.0.20 --wan-ip new # give a server its own public IP in one step
qc fw vpn 7 add alice && qc fw vpn 7 profile 5 --out alice.ovpn   # .ovpn downloads ONCE
qc fw tunnels 7 add --label HQ --remote 192.168.1.0/24 --lans 11
qc fw tunnels 7 config 4 --out hq.conf        # far-end WireGuard config, ONCE
qc fw update 7 --yes                          # apply a pending OPNsense update
qc fw delete 7 --yes
```

Create and delete send an `Idempotency-Key`. Firewalls are pay-as-you-go only.
A key can be limited to one firewall (panel → API → limit this key): it can then
operate that firewall but not create or delete any.

**Load balancers** (a hostname on the shared HAProxy fleet; HTTP listeners are
Host-routed with free managed certificates, TCP listeners claim a port; backends
are your own servers' public addresses):

```sh
qc lb info                                    # price, limits, TCP port range (no sizes - one shared-fleet product)
qc lb create --label web --yes                # lb-<slug>.<base> - CNAME your domain to it
qc lb listeners 3 add --http --tls managed --redirect --hc-path /healthz
qc lb backends 3 5 add --ip 203.0.113.10 --port 8080
qc lb backends 3 5 add --ip 203.0.113.11 --port 8080 --weight 50
qc lb backends 3 5 drain 9                    # take one out of rotation for a deploy, undrain after
qc lb domains 3 add www.example.com           # prints the CNAME / TXT to set
qc lb domains 3 verify 2                      # certificate follows once verified
qc lb listeners 3 add --tcp --port 10022      # a raw TCP port on the fleet
qc lb show 3                                  # live backend health + sessions
qc lb delete 3 --yes
```

**Storage boxes** (quota'd SFTP storage - metered per GB used, or a fixed monthly
plan - with snapshots, an IP allowlist and key-based login). Creating, resizing and
mode changes spend credit, so the key needs the `billing` role (or higher):

```sh
qc box plans                                  # metered price + the fixed plans
qc box create --metered --cap 100 --label backups --yes   # SFTP password printed ONCE
qc box create --plan sb-500 --yes
qc box show 12
qc box snap 12 auto on --keep 7               # daily snapshots, keep a week
qc box snap 12 create                         # one now
qc box allow 12 add 198.51.100.0/24           # SFTP only from here
qc box keys 12 set 4                          # key-based login (id from the panel key manager)
qc box resize 12 --cap 250
qc box password 12 --yes                      # rotate (shown once)
qc box delete 12 --yes
```

Snapshots are read-only under `/.zfs/snapshot/<name>/` on the box itself - restore
by copying files back over SFTP.

**Managed databases** (PostgreSQL / MariaDB / Valkey on dedicated resources,
optionally a 3-node HA cluster). An instance is real servers billing hourly from
the moment it exists, so `create` and `restore` are `--yes` gated and idempotent;
every password is printed once and never retrievable; there is no shell:

```sh
qc db sizes                                   # engines + sizes with ALL-IN monthly prices
qc db create --label app --engine postgres --size s --allow 198.51.100.7/32 --database app --yes
                                              # admin password printed ONCE
qc db show 5                                  # connection details, users, databases, backups, usage
qc db ca 5 --out ca.pem                       # the CA your clients verify TLS against
qc db users 5 add app                         # generated password printed once
qc db users 5 grant 11 3 readwrite
qc db databases 5 add reports --extensions pgcrypto
qc db allow 5 add 198.51.100.0/24 --label office
qc db set 5 max_connections=200               # engine settings from the whitelist
qc db backup 5                                # full backup now (nightly + PITR run anyway)
qc db restore 5 --at 2026-10-06T08:30:00Z --label app-restore --yes   # a NEW instance
qc db recover 5 app --at 2026-10-06T08:30:00Z # one database back INTO this instance
qc db admin-password 5 rotate --yes
qc db delete 5 --yes                          # backups kept for the grace period
```

Private instead of public: `--network <id>` (one of your private networks with a
router) replaces `--allow`. `--ha` builds a three-node cluster (where offered).

**Hosted DNS** (zones by id or name; record sets are whole-set upserts):

```sh
qc dns zones                                  # your zones + our nameservers
qc dns add example.com
qc dns set example.com www A 203.0.113.10 203.0.113.11 --ttl 120
qc dns set example.com @ MX '10 mail.example.com.'
qc dns set example.com _acme-challenge TXT 'token'   # a TXT-only zone-scoped key is enough
qc dns show example.com
qc dns rm example.com www:A                   # '@:TXT' for an apex set, or the numeric id
qc dns check example.com                      # is the domain delegated to us?
qc dns export example.com > example.com.zone
qc dns import example.com --file old-zone.txt
qc dns delete example.com --yes
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

## Updating

`qc` checks for a newer version about once an hour and tells you after a command
when one is out (on stderr, so `--json` output is never touched). Then:

```sh
qc update            # downloads, verifies it parses, swaps it in, keeps qc.prev beside it
qc version --check   # just ask the panel what the latest is
```

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
