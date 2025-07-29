This folder contains scripts that I use to maintain my containers and the system that runs them.

Like the other bits, you will probably need to use these as examples rather than copying them directly, as they are highly personalized to my system.

# Script Notes

## all-containers.sh

**This is a fully automated script to stop, start, restart and update containers.**

I basically use this instead of something like Portainer to manage my system.

## system-cron-startup.sh

**This script will start everything on your system.**

This script is used to start up the containers when the system boots.  
**You need to edit it to remove stuff that you don't have, like my "Metatron" script.**

You should add it to crontab by running `crontab -e` and adding a line like this:
`@reboot /home/chrisl8/containers/scripts/system-cron-startup.sh`

## system-health-check.sh

**This script will check the health of your system and notify you if anything is down.**

I use Healthcheck.io with this. In order for that to work you must get a key from that site for yourself, and add it to a file called  
`healthcheck.conf`  
with contents that look like this:  
`HEALTHCHECK_PING_KEY=YOUR_HEALTHCHECK_PING_KEY`

This script also checks for down Tailscale devices and notifies about them. However you likely have many that you don't care about, so you can create a file called:  
`excluded_devices.conf`  
and add the following lines:

```
EXCLUDED_DEVICES_FOR_EMAIL="mycomputer1|mycomputer2|myphone"
EXCLUDED_DEVICES_FOR_ERROR_COUNT="this-server|something-else"
```

Note the use of the `|` character to separate entries.

The first entry excludes things from all checks, including emailing you.  
Devices in the second entry only will still send you an email if they are down, but they won't result in an "error" state flagging the system as "down" in healtchecks.io
