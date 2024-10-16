package main

import (
    "bufio"
    "fmt"
    "net/http"
    "os"
)

func main() {

    resp, err := http.Get(os.Getenv("HOME_PAGE_URL"))
    if err != nil {
        panic(err)
    }
    defer resp.Body.Close()

    fmt.Println("Response status:", resp.Status)

    scanner := bufio.NewScanner(resp.Body)
    for i := 0; scanner.Scan() && i < 5; i++ {
        fmt.Println(scanner.Text())
    }

    if err := scanner.Err(); err != nil {
        panic(err)
    }
}
