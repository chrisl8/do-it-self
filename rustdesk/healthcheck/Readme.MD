# Go based Healthcheck

These are very simplistic go based health check binaries.  
Built this way and put here because it will run within the "FROM scratch" containers that runs rustdesk.

The source code `.go` files are **not** required, I just included them for completeness.

You must ensure that they are statically linked if you rebuild them, so to build it you need to run:

```bash
CGO_ENABLED=0 go build checkForHbbrProcess.go
CGO_ENABLED=0 go build checkForHbbsProcess.go
```

Also note the healthcheck format: `test: ["CMD", "/healthcheck/checkForHbbsProcess"]` which avoids it trying to run `sh` or any shell, since none exists in the "FROM scratch" container.
