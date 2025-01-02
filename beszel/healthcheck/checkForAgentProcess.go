package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

func main() {
	processName := "agent"
	matches, _ := filepath.Glob("/proc/*/exe")
	for _, file := range matches {
		target, _ := os.Readlink(file)
		if strings.Contains(target, processName) {
			fmt.Printf("Process %s found\n", processName)
			os.Exit(0)
		}
	}
	fmt.Printf("Process %s NOT found\n", processName)
	os.Exit(1)
}
