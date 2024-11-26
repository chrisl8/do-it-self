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

Frist, I have been in the situation multiple times now where something didn't work and the application author said, "That isn't our image, it works here, contact the container builder." and Linuxserver.io said, "We don't support that image, contact the application author." I don't need that kind of run-around. I'd rather just use the official images and get support from the people who wrote the application.
Second, I've been stuck more than once wanting a recent fix to an issue that cropped up in a release, but Linuxserver.io was taking days to update their image.

So I just use the official images and/or build my own compose files.

I do use Linuxserver.io for some things as you may see in the compose files.
I could see myself using them more in the future, especially if I could get involved in their community and help them out, but for now I'm basically learning and doing things myself, which works for me.

4. You run a lot of our containers as root, isn't that dangerous?

This is a personal setup, and I'm not worried about it.
You can form your own opinion on this. The Internet has plenty of opinions on this topic.
