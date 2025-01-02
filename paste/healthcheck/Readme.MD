# Go based Healthcheck

This is a very simplistic go based health check binary.  
Built this way and put here because it will run within the Distroless container that runs tclip.

The source code file `get-home-page.go` is **not** required, I just included it for completeness.

You must ensure it is statically linked if you rebuild it, so to build it you need to run:

```bash
CGO_ENABLED=0 go build get-home-page.go
```

Also note the healthcheck format: `test: ["CMD", "/healthcheck/get-home-page"]` which avoids it trying to run `sh` or any shell, since none exists in the Distroless container.
