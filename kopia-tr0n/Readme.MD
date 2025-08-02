This instance of Kopia is meant to be used remotely by other people, not me

On first start you need to do some chores:

1. You must uncomment `- --tls-generate-cert` in the compose file so that it will make a certificate and then write down the key it gives you.
2. On second start make sure this is commented out.
3. You need to build a repository for kopia to use;

```
docker exec -it kopia-tr0n /bin/bash
kopia repository create filesystem --path /repository
```

Then restart the container and it will pick up the newly created repository as you can see when you log into the website.

You can add backup users similarly:

```
docker exec -it kopia-tr0n /bin/bash
kopia server user add chris10@hostname
```
