# My Do It Self Setup

This is a collection of docker-compose files for various services that I run on my home server.

I don't expect you to use this exactly as it is, but I hope it will give you some ideas.

# Setup & Prerequisites

## TailScale

This setup is entirely dependent on TaleScale for networking.

While my goal is to de-corporate my life, I have found that Tailscale is my one exception that makes it all work easily and reliably enough to be useful for me.

## System

This is meant to run on an x86_64 Linux server with Docker and Docker Compose installed.

It isn't meant to run on a Pi, so you may need to adjust some things if you are using one.

There is a section under OS below now that walks through some details of setting up an Ubuntu system that will run these containers.

## Setup

### Git Repos

A few folders require a git repo to be pulled in to build the image.

Here is the current list as a set of commands to run.

```bash
cd dawarich
git clone https://github.com/Freika/dawarich.git
cd ..
cd minecraft
git clone https://github.com/itzg/docker-minecraft-bedrock-server.git
cd ..
```

It will be on you to keep up with updating those repos.
I typically subscribe to their releases in github so that I know when to do so.

### Mounts

The compose files all have my specific mount points in them. You will need to update those to point to your own system paths.

### User

_NOTE: This doesn't work for every container. I have had to "undo" this in some cases to restore reliable operation._

One time I had a dumb idea, fueled by the Internet's "don't run as root!" craze. I regret this now.

I attempted once to run each "stack" of services as a user, using the format `stackname-docker`.

For each stack that is still this way you must make a user, get the UUID, and then use that in the compose file.

Then you also must create the data volume mounts and make the container user the owner of them.

Adding yourself to the container's run-as group is also a good idea so that you can easily edit the files from the host. _Remember that you must log out and back in to apply your new group membership._

I am also made the Tailscale sidecar container run as the same user, meaning that you must also ensure that the container user owns their config files.

Here is a bit of a walkthrough with some helpful one-liners.

```bash
cd ~/continers/stackname
sudo mkdir -p /mnt/2000/container-mounts/$(basename "$PWD")/data
sudo useradd --no-create-home $(basename "$PWD")-docker
id $(basename "$PWD")-docker
sudo usermod -a -G $(basename "$PWD")-docker $USER
sudo chown -R $(basename "$PWD")-docker:$(basename "$PWD")-docker /mnt/2000/container-mounts/$(basename "$PWD")/*
sudo chmod ug+rX,o-rwx -R /mnt/2000/container-mounts/$(basename "$PWD")/*
sudo chown -R $(basename "$PWD")-docker:$(basename "$PWD")-docker tailscale-config tailscale-state
```

_Note that many containers will only start or even run as root. I made some attempt to not do this, but I was only willing to put in so much effort._

My experience is that many many users on Reddit think running anything in a contaienr as root is the end of the world, while most developers who provide containers don't think this matters at all. The disconnect means that unless I am willing to rebuild the containers myself, I will need to run them as the author intended.

## Start/Stop Script

You can run the script `allContainers.sh` to start and stop all of the containers.

I have this in my crontab:
`@reboot /mnt/250b/containers/allContainers.sh --start`

# My Layout Explanation

## Folder Structure

Each project has a folder in the root of the repository.

_Docker Compose uses the name of the folder that contains the `compose.yaml` file as the "project name", so having a unique and meaningful folder for each container is important._ There are other ways to set the project name, but this is what I use.  
The project names aren't super important except that compose gets confused if multiple projects exist with the same name and will warn about orphans.

Each of those folders should have a `compose.yaml` file.

Any other files that may contain a `Dockerfile` should then be in a subfolder.
The compose file can use the context tag to reference it for building.

This way the root is kept clean and also if the project is a git repository it can
be left clean and updated as needed.

## Compose files

Always named `compose.yaml`
Add a comment to the top with the source if it was originally copied from somewhere else.

** Do not add a `image` tag if they have a `build` section. **
This just confuses things, or worse pulls down an image and also builds it, causing duplication.

**Note: if you don't specify the tag in the image name, latest will be used.**

### Formatting

I generally remove all blank lines.
Copious comments.
Then whatever auto-formatting the IDE I'm using at the moment applies.

### Tags

Typically I use the `:latest` if that works, and don't actually specify it in the compose file as `:latest` is the default.

### Environment Variables ond Files

Docker Compose automatically pulls everything from `.env` into the COMPOSE FILE, for use in the COMPOSE FILE,  
however these variables are NOT seen WITHIN the containers!

To get them into the container, they must be passed in the `environment` section of the compose file,
or you can create a `env_file` section to pull in a file.

In theory you **can** set `env_file: .env` but this is basically saying, "put the same variables in two places" and many people dislike this.

Hence the use of the odd looking, but actually quite correct:

```yaml
environment:
  - VAR1=${VAR1}
```

The benefit being that you do only put each variable in exactly the container it should be in and no more places.  
The down-side is that it is wordy. I won't hate you if you use `env_file: .env` but I will try not to do it myself.

My pattern is to use only the `.env` file for all private credentials, and then to use ${VAR} in the compose file for everything.
Hence you will not seen any `env_file` sections in my compose files.

### Credentials

Do not place them in compose files.
Instead, place them in files in my `~/credentials` folder.  
Name them `container-name.env`
Then make links called `.env` files in the root of the project that link back to the files in my home folder.
This way they get automatically imported by docker-compose.

i.e. `ln -s $HOME/credentials/wallabag.env .env`

### Sensitive vs. Generic Config

Put anything else sensitive such as personal URLs in the same file linked to by `.env`.  
Put anything generic, even if it is personal preference, in the `compose.yaml` file.

## Tailscale

### Credentials

Use the same credentials for every container. Make a `tailscale.env` link back to the same file in my `~/credentials` folder.

## Mounted Volumes

- **Only** use a folder within the project if the content is stricly configuration data, and hence should be edited with an IDE.

- Otherwise, for data mounts, use a folder ona disk `/mnt/...` in a folder called `container-mounts`
- Inside `container-mounts`, create a folder for each container that needs a data mount.
  - Inside there make a folder with the project name just the same as the one in `containers`
    - Inside there make a folder for the data mount.
      - This keeps the data well separated, but makes it clear what drive they are on and what they do.
      - Mounts are placed on drives based on their speed and available space, so they can be all over the place.

If possible, always separate config and data mounted volumes.

# Networking Options

I've set up networking in a few ways here and I'll explain why I use each and the benefits and drawbacks.

## Host

The easiest and most simple setup is to add this to the compose file:
`network_mode: "host"`
In this case, the container literally sits in the same location as the host as far as networking is concerned.

The main reason **not** to do this is port conflicts. You cannot run ten copies of NGINX or MariaDB on the same host this way unless you are OK with typing port numbers a lot.

The main reasons **to** do this are:

- Local network access. If you have something that needs a lot of rapid data access this bypasses any tailscale stuff.
- Full access to all ports that the application may want open.

This is the case with urbackup, where it has a series of UDP ports it talks on and listens to in order to discover clients.
Getting these all into the ports list is notoriously difficult, so this is a good way to do it.
We also don't want to pass gigabytes of backup traffic through tailscale.

The same goes for Minecraft.

## Tailscale Sidecar with a Network

This is the most common setup I use.
In this setup the compose file has a network line in it:

```yaml
networks:
  whatever-net:
```

and then a Tailscale "sidecar" container is added to the compose file
This means that each container is its own "host" but they can talk to each other.

This means that in the `tailscale-confg\tailscal-config.json` fie you must tell it the name of the container that it connects to.

The main benefit of this is that you can easily perform an HTTPS proxy with Tailscale, giving you automatic SSL certificates without exposing anything else.

The drawback is that you can ONLY see that one port via tailscale.

This is best for things that are a web server. You run it on whatever port you want to, and then you can access it via tailscale.

This also allows you to run an unlimited number fo such services, since every one has it is own tailscale DNS entry and IP address, there are no port conflicts and no need to type ports.

You **can** if you want to, still expose a container's ports to the host. This is useful both:

1. If you want to access a port other than the one you have exposed to tailscale.
2. You want direct access to it, asside from tailscale, for faster zero-cpu usage operations.

## Tailscale Network Only

Another option is instead of the network that all hosts are on, you use `network_mode: service:ts`, where "ts" is the name of the tailscale container, in the container running the application.

You still also have a tailscale "sidecar" container, but now instead of a docker network that both are on, the application container is seen to be on the SAME network as the talescale container.

The benefit (or drawback) of this is that you can see all the ports of the application container via tailscale.

Note that when you set it up this way your `tailscale-confg\tailscal-config.json`, if set for proxy HTTPS, must point to localhost/127.0.0.1 because the container lives in the tailscale container network, not its own network.

This works great for minecraft, since it means clients can connect to whatever ports it wants to use.

Note with minecraft I also exposed the port locally, so that I can connect to it via the host network, bypassing tailscale.
This reduces latency and CPU load (for encryption) on the server when I am on the same network.

There isn't a lot of reason **not to** use this setup on every container, except that in theory it exposes more of the container.
In theory, since it is all exposed via tailscale, it is only exposed to me, but it is still seems like a good idea to keep the number of exposed ports to a minimum.

I don't know if there is any performance benefit/drawback of the two setups.

# Docker hints

## Docker Healthchecks

If you are having trouble getting one to work you can see the output of the healthcheck by running:
`docker inspect --format "{{json .State.Health }}" <container name> | jq`

# Notes on specific containers

## Your Spotify

I'm using the lscr.io version of this instead of directly calling the author's repo because the lscr.io version combines the "client" (web site) and "server" (back end service) into one container, which I wanted and which I wasn't sure how to do myself at the time.  
I'm pretty sure that I could convert, and I may because I tend to be dumb that way, but for now the lscr.io one works well.

# Answers to Questions Nobody Asked

1. Why do you use the latest version of so many things, isn't it dangerous not to pin versions?

My experience is that it is more dangerous to pin versions. I'd rather have a crash than a security hole.  
I have had more problems with old versions than new ones.  
Besides, I am happy to report bugs as an early adopter with this personal setup.

2. Why do you use so many git clones instead of just pulling their published images?

While I'm trusting enough to use latest images, I don't trust random repositories to keep their images up to date.
Basically, this is how I feel and my life experience has taught me to trust this path for this use case.
It is definitely a per-image decision though.
I'm happy to use the official images for things like MariaDB and NGINX for instance.

3. Why don't you use https://www.linuxserver.io/ images?

First, I have been in the situation multiple times now where something didn't work and the application author said, "That isn't our image, it works here, contact the container builder." and Linuxserver.io said, "We don't support that image, contact the application author." I don't need that kind of run-around. I'd rather just use the official images and get support from the people who wrote the application.
Second, I've been stuck more than once wanting a recent fix to an issue that cropped up in a release, but Linuxserver.io was taking days to update their image.

So I just use the official images and/or build my own compose files.

I do use Linuxserver.io for some things as you may see in the compose files.
I could see myself using them more in the future, especially if I could get involved in their community and help them out, but for now I'm basically learning and doing things myself, which works for me.

4. You run a lot of our containers as root, isn't that dangerous?

One day I thought, "Let's make everything run 'not as root'!". Then I spent a lot of time digging through documentation on every stack I use, trying things, running into a lot of walls and bug and issues. Eventually I got **most** of them to run as non-root. Then they started to fail randomly and I found odd side-effects to this change. Basically running as non-root is non-trivial and brittle when the container author didn't make it easy.

TL;DR: This is a personal setup, I don't have time or patience for this, and I'm not worried about it, but see the section above on "user" for more information about my one time attempt and the fallout that remains.

# OS Setup Notes

Note that you do not need to follow the links labeled `Source Reference:`, but if you find the instructions not working, you can use that to see where I got my information.

These are notes I made to help a friend set up their own box based on my setup.

**Throughout this text replace `neuromancer` with your own server name**

## Install the OS

Despite wanting a Desktop GUI, we want to do things like use RAID, so we have to use the Server install.

Go to [Get Ubuntu Server](https://ubuntu.com/download/server) and download the latest LTS version, 24 at this time, which should be the big green button.

You can then follow the instructions at [Install Ubuntu Desktop](https://ubuntu.com/tutorials/install-ubuntu-desktop) for the most part, just use the image you got above.

### Install Options

- I chose the "minimal" install so that I pick what goes onto the system later
- I did set SSH to come up and allow password logins so that I can immediately use another system to configure this one remotely.

## Software

As I chose a **minimal** setup, even some very basic things are missing! Plus I actually do want a desktop.

I've tried to place everything I know we will need here to make it quick to start with.

- Initially log in as yourself locally and use `ip` to find the IP address.
- _Then you can SSH in as yourself and do this remotely._
  **Before saying "yes" do look at the "recommended" packages and make sure it isn't installing a boatload of trash!**

```bash
sudo apt update
sudo apt upgrade
sudo apt autoremove
sudo apt install ubuntu-desktop-minimal ubuntu-advantage-tools vim ca-certificates curl samba wsdd-server
```

Reboot now to get everything to "come up" and ensure the Desktop works.
`sudo shutdown -r now`

We will install some other software that requires more setup later, but this will get is going.

## SSH Lockdown

- Connect remotely to it over SSH using the password, then:

```bash
mkdir .ssh
chmod 700 .ssh
vi .ssh/authorized_keys
```

- Put SSH Public key from 1Password in this file and save and close it

```bash
chmod 600 .ssh/authorized_keys
exit
```

- Log in via SSH as yourself and make sure you can run `sudo su -` before we drop the root login!

## Disable Root SSH

```
vi /etc/ssh/sshd_config
```

Update these lines:

- PermitRootLogin no
- PasswordAuthentication no
  Save and close the file, and restart SSH

```
service ssh restart
```

BEFORE logging out as root:

- Test login as root, should fail.
- Test login as yourself
  **_Do everything from here on as `yourself`, not root_**

## Swap Space Setup

**Optional**  
Start by running:
`swapon --show`  
If your system has ANY swap space, then you might want to just skip this anyway.

My system has 32 **gigabytes** of memory, but it still likes to eat all of its swap space sometimes. To basically placate it, I've made an enormous swap file on a spare SSD for it to play with.

```bash
sudo su -
swapon --show
swapoff -a
file /swap.img
rm /swap.img
fallocate -l 64G /mnt/120/swap.img
chmod 600 /mnt/120/swap.img
mkswap /mnt/120/swap.img
file /mnt/120/swap.img
swapon /mnt/120/swap.img
swapon --show
```

Be sure to add it to the end of `/etc/fstab` and remove any existing entries:
`/mnt/120/swap.img       none    swap    sw      0       0`

### Swappiness

Also just make it use swap less

```
sudo su -
cat /proc/sys/vm/swappiness
```

General recommendation of Internet is 10,  
but it keeps filling up for no reason without using all of the memory,  
so setting it to 1.  
Note that setting it to 0 can cause the entire system to lock up for hours due to . . . well I'm not sure what, but it was bad, so stick with 1.

`vi /etc/sysctl.conf`  
Add:  
`vm.swappiness=1`  
Apply it:  
`sysctl -p`  
Check:  
`cat /proc/sys/vm/swappiness`

Between the bigger swap file and low swappiness and the memory in the system, this should not be an issue now.

### Clear Swap

**Optional: This is just for future reference really:**
After that if you want to shove the swap out into RAM run:
`sudo swapoff -a; sudo swapon -a`
Watch `htop` while it runs to see it happen.

## Docker

Source Reference: https://docs.docker.com/engine/install/ubuntu/#installation-methods

```bash
# Add Docker's official GPG key:
sudo apt-get update
sudo apt-get install ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

# Add the repository to Apt sources:
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

Allow yourself to run docker without sudo:  
`sudo usermod -aG docker $USER`  
Log out and back in.

- Test just to prove that it worked:  
  `docker run hello-world`

### Fix Address Pool Size for Docker

- Without this, you will get the error  
  `all predefined address pools have been fully subnetted`  
  after starting up too many containers

Source Reference: https://www.reddit.com/r/selfhosted/comments/1az6mqa/psa_adjust_your_docker_defaultaddresspool_size/

Run:
`sudo vim /etc/docker/daemon.json`

```
{
  "default-address-pools": [
    {
      "base" : "172.16.0.0/12",
      "size" : 24
    }
  ]
}
```

Restart Docker:  
`sudo systemctl restart docker`  
or reboot the system.  
Check if it worked (only works if you have containers set up and running already):  
`docker network inspect homepage_homepage-net | grep Subnet`  
_Bad_  
 "Subnet": "172.18.0.0/16",  
**Good**  
 "Subnet": "172.16.1.0/24",

## Tailscale

Source Reference: https://tailscale.com/kb/1031/install-linux

**NOTE: If this is a re-install, DELETE the old instance first so we don't get a "-" name!**

`curl -fsSL https://tailscale.com/install.sh | sh`
`sudo tailscale up`

## Samba

This will allow you to share folders on the Linux box with Windows via Windows Networking, which can be highly convenient.  
Remember, it is best to dedicate folders to this purpose, don't try to "share" folder that is also used by Docker for something.  
Instead either set up some sort of auto-copy/sync or get used to using other methods to move files over.

`sudo apt install samba`

This is required for Windows to see them!

```
sudo systemctl stop nmbd.service
sudo systemctl disable nmbd.service
sudo apt install wsdd-server
```

Note that Windows no longer allows "guest" shares, so we have to password protect them. I'm going to use a single password for everyone.

The "scanner" user is my user for SAMBA access. It is a dumb name, but it is because I started with that.  
\*\*You can use any name you want instead of `scanner` here.

```bash
mkdir -p /mnt/2000/samba/scanner
sudo adduser scanner --home /mnt/2000/samba/scanner --no-create-home --shell /usr/sbin/nologin --ingroup sambashare
```

- Set a password for the user. It doesn't ever get used, so just make it hard and save it in 1Password

```bash
sudo chown -R scanner:sambashare /mnt/2000/samba
sudo chmod -R u+rwX,g+rwX /mnt/2000/samba
sudo smbpasswd -a scanner
```

- THIS is the password that gets used:

```bash
sudo smbpasswd -e scanner
sudo vim /etc/samba/smb.conf
```

Source Reference: https://askubuntu.com/questions/1117030/how-do-i-configure-samba-so-that-windows-10-doesn-t-complain-about-insecure-gues

- Most of this stuff is defaults, but just in case:

```
[global]
    disable netbios = yes
   workgroup = WORKGROUP
   server string = %h server (Samba, Ubuntu)
bind interfaces only = no
   log file = /var/log/samba/log.%m
   max log size = 1000
   logging = file
   panic action = /usr/share/samba/panic-action %d
   server role = standalone server
   obey pam restrictions = no
   unix password sync = yes
   passwd program = /usr/bin/passwd %u
   passwd chat = *Enter\snew\s*\spassword:* %n\n *Retype\snew\s*\spassword:* %n\n *password\supdated\ssuccessfully* .
   pam password change = yes
   usershare allow guests = yes

[printers]
   comment = All Printers
   browseable = no
   path = /var/tmp
   printable = yes
   guest ok = no
   read only = yes
   create mask = 0700

[print$]
   comment = Printer Drivers
   path = /var/lib/samba/printers
   browseable = yes
   read only = yes
   guest ok = no
```

### For sure change

- `disable netbios = yes`
- `bind interfaces only = no`
- `obey pam restrictions = no`
- `#   map to guest = bad user`

**Note that it is ESSENTIAL that `map to guest` is commented out or set to `never`.**

- These are the actual shares

```
[MyFancyShare]
    create mask = 0664
    force create mode = 0664
    force directory mode = 2770
    force group = sambashare
    force user = scanner
    guest ok = Yes
    path = /mnt/2000/samba/MyFancyShare
    read only = No
```

You can then repeat the above as often as you like in the file to share more folders.  
Again, don't get clever and try to share folders that are also used by Docker, you will make a mess!  
Instead use this to store things that you ONLY store on this shared drive and/or as a temporary spot to copy in large files that you then use a shell to copy out to another place.

Add yourself to the _sambashare_ group so you can interact with files there:

```bash
sudo usermod -aG sambashare $USER
```

### Folder Permissions

```
chmod go+rx /mnt
chmod go+rx /mnt/2000
chmod go+rx /mnt/2000/samba
chmod go+rx /mnt/2000/samba/MyFancyShare
```

You get the idea.

### Starting Samba

Now run:

```
testparm
```

Look at the output to see if it is showing any errors in your config.

Then run:

```
sudo systemctl restart smbd.service
```

to actually start things.

Then try connecting to the share from Windows.

If things aren't working run:  
`tail -f /var/log/samba/*`

If you see this error:  
**chdir_current_service: vfs_ChDir(/mnt/250b/ScanHere) failed: Permission denied.**  
This probably means your permissions are wrong, so look at your shared folder **and parent folders** to make sure the Samba user that you created has permission to traverse the parent folders and read/write the folder itself.

## DuckDNS

You don't need DuckDNS if you are using TailScale, but if you want it, follow these instructions:

I am just going to run this on the host, as it is literally a cron job.
https://www.duckdns.org/install.jsp

## Email with Fastmail

It is really useful to be able to send email from your server, but it is also difficult.  
Here is how I do it.  
Note that I'm using Fastmail, which you may not have.  
Note that you also need a domain name to use. I used `example.com` here, but use one that you have registered in FastMail.

Source Reference: https://askubuntu.com/a/1042819

```
sudo apt install postfix mailutils
```

General type of mail configuration: **Satellite system**  
System Mail Name: `example.com`  
SMTP relay host: `[smtp.fastmail.com]:587`

Edit `/etc/hosts` replacing:  
`127.0.1.1 neuromancer`  
with  
`127.0.1.1 Neuromancer.example.com Neuromancer`  
_This may not be required_

Source Reference: https://askubuntu.com/a/1083644/452730  
To make `mail` send from the right domain  
`sudo vim /etc/mailutils.conf`

```
address {
  email-domain example.com;
};
```

Add to `/etc/postfix/main.cf`:

```
smtp_use_tls = yes
smtp_sasl_auth_enable = yes
smtp_sasl_password_maps = hash:/etc/postfix/sasl/sasl_passwd
smtp_sasl_security_options = noanonymous
smtp_sasl_tls_security_options = noanonymous
```

`sudo vim /etc/postfix/sasl/sasl_passwd`  
`[smtp.fastmail.com]:587 neuromancer@example.com:PASSWORD`

`sudo vim /etc/aliases`

```
# See man 5 aliases for format
postmaster:    root
root: yourself@example2.com
yourself: yourself@example2.com
```

Note that it does NOT work to set the alias to the same domain as your own system, as postfix then strips off the FQDN and gets confused.

Run:

```
sudo su -
postmap /etc/postfix/sasl/sasl_passwd
chown -R root:postfix /etc/postfix/sasl
chmod 750 /etc/postfix/sasl
chmod 640 /etc/postfix/sasl/sasl_passwd*
newaliases
systemctl stop postfix.service
systemctl start postfix.service
exit
```

NOTE: Make sure that Fastmail allows sending FROM `yourself@example.com` from the user you set up in the sasl_passwd file. The system will send from `yourself` because well that's the user, it doesn't change that.
You should also set up `root@example.com` as a valid alias for that account in FastMail.

This should work now:

```
echo "Test to root." | mail -s "Test message to root" root
```

Postfix logs are in journal. Run:  
`journalctl -t postfix/smtpd -t postfix/smtp`  
if you need to debug.

## SMART Disk Monitoring

I think this alone adds some monitoring:

```bash
sudo apt install smartmontools
```

I get emails now about SMART events.

```bash
sudo smartctl -a /dev/sda
```

## APC UPS

If you have a UPS

`sudo apt install apcupsd`

Source Reference: https://forums.linuxmint.com/viewtopic.php?t=308171

Edit the `/etc/apcupsd/apcupsd.conf` file and ensure the `DEVICE` line is by itself with nothing after it, so basically:

```
UPSTYPE usb
#DEVICE /dev/ttyS0
DEVICE
```

For whatever reason the default is to have `/dev/ttyS0` on the end which breaks USB UPSs working.

To enable and start the service:
`systemctl start apcupsd ; systemctl enable apcupsd`

To restart if you changed settings:
`sudo systemctl restart apcupsd`

`apcaccess` should dump stats about the UPS.

I should set up a cron job to monitor this.

### Netdata with APC

Source Reference: https://www.netdata.cloud/integrations/data-collection/ups/apc-ups/

Lots of good info there, ultimately I ended up setting up the config file to point to the Tailscale instance of the host!

```
cat /mnt/250a/container-mounts/netdata/netdataconfig/go.d/apcupsd.conf

## All available configuration options, their descriptions and default values:
## https://github.com/netdata/netdata/tree/master/src/go/plugin/go.d/modules/apcupsd#readme

jobs:
  - name: local
    address: neuromancer.jamnapari-goblin.ts.net:3551
```

## Rustdesk Remote Desktop for GUI

_Optional_

Download latest `.deb`, but not nightly, from https://github.com/rustdesk/rustdesk/releases

```
sudo apt install -f /mnt/500/samba/Multivac/rustdesk-1.3.2-x86_64.deb
```

`sudo vim /etc/gdm3/custom.conf`
Set `WaylandEnable=false` by uncommenting the line and then reboot.

Make sure it starts on boot?
`sudo systemctl enable rustdesk`

In the client point it at my local instance of the server
rustdesk: `rustdesk.jamnapari-goblin.ts.net` and add the key from the container's data mount.

## Git Credential Manager

So that I can push/pull to/from Gitea without pasting my password every time

### Install

https://github.com/git-ecosystem/git-credential-manager/blob/release/docs/install.md

```
wget https://github.com/git-ecosystem/git-credential-manager/releases/download/v2.6.1/gcm-linux_amd64.2.6.1.deb
sudo dpkg -i gcm-linux_amd64.2.6.1.deb
git-credential-manager configure
git config --global credential.credentialStore plaintext
```

Go to a folder with a repo in it and do a pull, the first time will cause an error that you can ignore and after that credentials will be stored:

```
git pull
fatal: Must specify at least one OAuthAuthenticationModes (Parameter 'modes')
Username for 'https://gitea.jamnapari-goblin.ts.net': chrisl8
Password for 'https://chrisl8@gitea.jamnapari-goblin.ts.net':
```

The credentials for this example will be here:
`~/.gcm/store/git/https/gitea.jamnapari-goblin.ts.net/chrisl8.credential`

Note that this means the password is in plain text and accessible by root and in backups.
I'm not worried about it as this git instance is locked in my VPN, but be aware.

## Fixes Potential Problems

### Slow boot due to timeout

`job systemd-network-wait-online.service/start running`
https://askubuntu.com/questions/1217252/boot-process-hangs-at-systemd-networkd-wait-online/1501504#1501504

This appears to be due to adding Desktop to a Server install and now we have two network services active.

Fix:

```bash
systemctl disable systemd-networkd.service
```

That disables the "server" one in favor of the "desktop" one, which is hopefully OK.

### Suspense and Hibernation

~~If the system seems to crash sometimes, by just going blank, but when you power cycle it it seems like it was always running, it may see the UPS as a "battery" and be putting itself to sleep!~~
I don't think that actually happend, instead it was a combination of crashing due to BIOS automatically overclocking the CPU to 4.4 GHz and Docker set to restart `always`, **but I never want to suspend this machine so:**

Make sure all suspend options are turned off in the Desktop settings for Power!

This should help too:

```
sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target
```

Now suspend won't even show up on the Desktop menu!
And under Settings-> Power you won't even see sleep/suspend options!

## Crontab

My personal crontab at the moment as an example.  
You will notice reference to a lot of scripts. Make an Issue in Github if you want me to share those.

````
# Start Stuff
@reboot /home/chrisl8/Scripts/neuromancer-cron-startup.sh

# Help Nextcloud perform its duties
*/5 * * * * /home/chrisl8/Scripts/nextCloudCronJob.sh

# Duck DNS
*/47 */1 * * * curl "https://www.duckdns.org/update?domains=ekpyroticfrood&token=143a6bd4-868a-45c6-99c5-2e61c908b6e1&ip=" >/dev/null 2>&1

# Check Neuromancer app health
*/15 * * * * /home/chrisl8/Scripts/containerCheckups.sh

# Check for and notify about container updates available
0 8 * * 1 /home/chrisl8/Scripts/containerUpdateReminder.sh

# Notify about need to run updates
0 8 1 * * apt list --upgradable```
````

## Start Everything Script

You saw the reference to the script named `/home/chrisl8/Scripts/neuromancer-cron-startup.sh` script in Crontab above. Here is the script contents:

```
#!/usr/bin/env bash

echo "Neuromancer booting up now..." | mail -s "Neuromancer just booted" chrisl8

if ! [ -d /home/chrisl8/logs ]; then
    mkdir -p /home/chrisl8/logs
fi

# Give the system a little time to finish booting
echo "Waiting for 30 seconds before starting up..." > /home/chrisl8/logs/neuromancer-cron-startup.log
sleep 30

# Clean up docker containers if the system went down hard
/home/chrisl8/containers/allContainers.sh --stop >> /home/chrisl8/logs/neuromancer-cron-startup.log

# Now start everything
/home/chrisl8/containers/allContainers.sh --start --no-wait >> /home/chrisl8/logs/neuromancer-cron-startup.log

cat /home/chrisl8/logs/neuromancer-cron-startup.log | mail -s "Neuromancer - All services started" chrisl8
```

## Container Health Check Script

cat /home/chrisl8/Scripts/containerCheckups.sh

```
#!/bin/bash

# List of devices to exclude from Tailscale status checks
EXCLUDED_DEVICES_FOR_EMAIL="mydesktop|myphone"
EXCLUDED_DEVICES_FOR_ERROR_COUNT="mydesktop|myphone|3dprinter"

ERROR_COUNT=0

# Check for unhealthy containers
DOCKER_ISSUES=$(/usr/bin/docker ps -a | tail -n +2 | grep -v "(healthy)")

if [ -n "$DOCKER_ISSUES" ]; then
  echo ""
  echo "Unhealthy containers detected:"
  echo "$DOCKER_ISSUES"
  echo ""
  ERROR_COUNT=$((ERROR_COUNT + 1))
fi

# Check for changes in container count
if ! [[ -e /tmp/docker-ps-wc-previous.txt ]]; then
  docker ps -a | wc -l > /tmp/docker-ps-wc-previous.txt
fi
docker ps -a | wc -l > /tmp/docker-ps-wc-now.txt
if ! diff /tmp/docker-ps-wc-previous.txt /tmp/docker-ps-wc-now.txt > /dev/null; then
  PREVIOUS_COUNT=$(</tmp/docker-ps-wc-previous.txt)
  NOW_COUNT=$(</tmp/docker-ps-wc-now.txt)
  echo "Docker Container count has changed from $PREVIOUS_COUNT to $NOW_COUNT"
  echo ""
  mv /tmp/docker-ps-wc-now.txt /tmp/docker-ps-wc-previous.txt
  if [ $NOW_COUNT -lt $PREVIOUS_COUNT ]; then
    echo "Docker Container count has decreased from $PREVIOUS_COUNT to $NOW_COUNT"
    echo ""
    ERROR_COUNT=$((ERROR_COUNT + 1))
  fi
fi

# Check Tailscale health
TAILSCALE_ISSUES=$(/usr/bin/tailscale status | grep offline | grep -vE "$EXCLUDED_DEVICES_FOR_EMAIL")

if [ -n "$TAILSCALE_ISSUES" ]; then
  # Wait 15 seconds and check again as often there are transient issues with tailscale
  sleep 15
  TAILSCALE_ISSUES=$(/usr/bin/tailscale status | grep offline | grep -vE "$EXCLUDED_DEVICES_FOR_EMAIL")
  if [ -n "$TAILSCALE_ISSUES" ]; then
    echo ""
    echo "Tailscale issues detected:"
    echo "$TAILSCALE_ISSUES"
    echo ""
    TAILSCALE_ISSUES=$(/usr/bin/tailscale status | grep offline | grep -vE "$EXCLUDED_DEVICES_FOR_ERROR_COUNT")
    if [ -n "$TAILSCALE_ISSUES" ]; then
      # Don't record error if it is just the ipad or sonicscrewdriver or other local devices that don't bring down the server.
      # I'm not sure why neuromancer itself sometimes shows offline, but if it really was, there would be bigger issues and they would be reported elsewhere
      ERROR_COUNT=$((ERROR_COUNT + 1))
    fi
  fi
fi

if [ $ERROR_COUNT -gt 0 ]; then
  exit 1
fi
```

Remember to replace my user ID with your own!

## That's it!

The `allContaienrs.sh` script should work and if you reboot you'll see the crontab calls that script.

## Healthchecks

I highly suggest using [Healtchecks.io](https://healthchecks.io/) and setting it up to monitor so you know if your entire domain went down.  
You can add it to crontab and you can integrate it into your health checks script as well if you like.
