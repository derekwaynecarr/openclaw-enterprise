package occdev

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"io/fs"
	"os"
	"path"
	"strings"
)

// Both local k3d profiles start the node with IPTABLES_MODE=legacy, so
// kube-proxy needs the host kernel's legacy iptables nat table. The node
// cannot load the iptable_nat module itself. On a host that never loaded it,
// for example one whose Docker uses nftables, kube-proxy exits, K3s shuts
// down, and k3d reports only a failure when its startup timeout expires.
// The preflight below fails fast instead when the host kernel can be read.

// hostFilesystem is the host root, replaced in tests.
var hostFilesystem fs.FS = os.DirFS("/")

const legacyNATModule = "iptable_nat"

const legacyNATRemedy = "sudo modprobe --all iptable_nat iptable_filter iptable_mangle br_netfilter"

const legacyNATTroubleshooting = `See "Local K3s cannot load the legacy iptables nat table" in docs/guides/operate/troubleshooting.md.`

type legacyNATState int

const (
	// legacyNATAvailable: the module is loaded or built into the kernel.
	legacyNATAvailable legacyNATState = iota
	// legacyNATUnloaded: the kernel ships the module, but it is not loaded.
	legacyNATUnloaded
	// legacyNATMissing: the kernel ships no legacy nat table at all.
	legacyNATMissing
	// legacyNATUnknown: the host does not expose enough to decide.
	legacyNATUnknown
)

// legacyNATTableState reads only world-readable kernel state. A loaded module
// appears in /sys/module and /proc/modules; a built-in one appears in neither
// /proc/modules nor, without parameters, /sys/module, so modules.builtin
// decides that case.
func legacyNATTableState(fsys fs.FS, release string) legacyNATState {
	if _, err := fs.Stat(fsys, "sys/module/"+legacyNATModule); err == nil {
		return legacyNATAvailable
	}
	if data, err := fs.ReadFile(fsys, "proc/modules"); err == nil && anyLine(data, func(line string) bool {
		name, _, _ := strings.Cut(line, " ")
		return name == legacyNATModule
	}) {
		return legacyNATAvailable
	}
	if data, err := fs.ReadFile(fsys, "proc/net/ip_tables_names"); err == nil && anyLine(data, func(line string) bool {
		return strings.TrimSpace(line) == "nat"
	}) {
		return legacyNATAvailable
	}
	if release == "" || strings.Contains(release, "/") || !fs.ValidPath(release) {
		return legacyNATUnknown
	}
	directory := path.Join("lib/modules", release)
	builtin, builtinErr := fs.ReadFile(fsys, path.Join(directory, "modules.builtin"))
	if builtinErr == nil && listsKernelModule(builtin, legacyNATModule) {
		return legacyNATAvailable
	}
	dependencies, err := fs.ReadFile(fsys, path.Join(directory, "modules.dep"))
	if err != nil {
		return legacyNATUnknown
	}
	if listsKernelModule(dependencies, legacyNATModule) {
		return legacyNATUnloaded
	}
	if builtinErr != nil {
		return legacyNATUnknown
	}
	return legacyNATMissing
}

// listsKernelModule matches the first path of each modules.builtin or
// modules.dep line, such as kernel/net/ipv4/netfilter/iptable_nat.ko.zst:.
func listsKernelModule(data []byte, module string) bool {
	return anyLine(data, func(line string) bool {
		file, _, _ := strings.Cut(line, ":")
		base := path.Base(strings.TrimSpace(file))
		return base == module+".ko" || strings.HasPrefix(base, module+".ko.")
	})
}

func anyLine(data []byte, match func(string) bool) bool {
	scanner := bufio.NewScanner(bytes.NewReader(data))
	scanner.Buffer(make([]byte, 0, 64<<10), 1<<20)
	for scanner.Scan() {
		if match(scanner.Text()) {
			return true
		}
	}
	return false
}

// checkLegacyNATTable runs before k3d creates the node. Host files describe
// the node's kernel only when the engine runs on this kernel, so the check
// applies only on Linux and only when the engine reports the host's kernel
// release; Docker Desktop, Podman machines, and other VM-backed engines are
// skipped. A host that does not expose its modules gets a warning, not a
// failure.
func (r *runner) checkLegacyNATTable(ctx context.Context) error {
	if developmentHostOS != "linux" {
		return nil
	}
	data, err := fs.ReadFile(hostFilesystem, "proc/sys/kernel/osrelease")
	if err != nil {
		return nil
	}
	release := strings.TrimSpace(string(data))
	if release == "" {
		return nil
	}
	format := "{{.KernelVersion}}"
	if r.engine == "podman" {
		format = "{{.Host.Kernel}}"
	}
	engineKernel, err := r.output(ctx, r.engine, "info", "--format", format)
	if err != nil || string(engineKernel) != release {
		return nil
	}
	switch legacyNATTableState(hostFilesystem, release) {
	case legacyNATUnloaded:
		return fmt.Errorf("the host kernel has not loaded the legacy iptables nat table (%s). The local k3d node runs K3s with IPTABLES_MODE=legacy and cannot load the module itself, so cluster creation would stall until its startup timeout. Load the modules on the host, then start again:\n  %s\n%s", legacyNATModule, legacyNATRemedy, legacyNATTroubleshooting)
	case legacyNATMissing:
		return fmt.Errorf("the host kernel %s provides no legacy iptables nat table (%s), which the local k3d node needs because it runs K3s with IPTABLES_MODE=legacy. Use a kernel that ships the module. %s", release, legacyNATModule, legacyNATTroubleshooting)
	case legacyNATUnknown:
		fmt.Fprintf(r.opts.Err, "Warning: could not confirm that the host kernel provides the legacy iptables nat table (%s) that the k3d node needs; continuing. If cluster creation stalls, run `%s` on the host. %s\n", legacyNATModule, legacyNATRemedy, legacyNATTroubleshooting)
	}
	return nil
}
