package occdev

import (
	"bytes"
	"context"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
)

const legacyNATTestRelease = "6.8.0-41-generic"

func legacyNATTestFiles(files map[string]string) fstest.MapFS {
	fsys := fstest.MapFS{"proc/sys/kernel/osrelease": {Data: []byte(legacyNATTestRelease + "\n")}}
	for name, data := range files {
		fsys[name] = &fstest.MapFile{Data: []byte(data)}
	}
	return fsys
}

const (
	legacyNATTestModules = "lib/modules/" + legacyNATTestRelease + "/"
	legacyNATTestDep     = "kernel/net/ipv4/netfilter/ip_tables.ko.zst: kernel/net/netfilter/x_tables.ko.zst\n" +
		"kernel/net/ipv4/netfilter/iptable_nat.ko.zst: kernel/net/netfilter/nf_nat.ko.zst kernel/net/ipv4/netfilter/ip_tables.ko.zst\n"
	legacyNATTestBuiltin = "kernel/net/netfilter/x_tables.ko\n"
)

func TestLegacyNATTableState(t *testing.T) {
	for _, test := range []struct {
		name    string
		files   map[string]string
		release string
		want    legacyNATState
	}{
		{"loaded module in sysfs", map[string]string{"sys/module/iptable_nat/refcnt": "1\n"}, legacyNATTestRelease, legacyNATAvailable},
		{"loaded module in proc", map[string]string{"proc/modules": "nf_nat 65536 1 - Live 0x0\niptable_nat 12288 0 - Live 0x0\n"}, legacyNATTestRelease, legacyNATAvailable},
		{"nat table registered", map[string]string{"proc/net/ip_tables_names": "filter\nnat\n"}, legacyNATTestRelease, legacyNATAvailable},
		// Built-in modules appear in neither /proc/modules nor, without
		// parameters, /sys/module.
		{"built into the kernel", map[string]string{
			legacyNATTestModules + "modules.builtin": "kernel/net/ipv4/netfilter/iptable_nat.ko\n",
			legacyNATTestModules + "modules.dep":     "",
		}, legacyNATTestRelease, legacyNATAvailable},
		// The reported failure: Docker with nftables never loads the legacy module.
		{"shipped but not loaded", map[string]string{
			"proc/modules":                           "nf_tables 380928 0 - Live 0x0\nnf_nat 65536 1 - Live 0x0\n",
			"proc/net/ip_tables_names":               "filter\n",
			legacyNATTestModules + "modules.builtin": legacyNATTestBuiltin,
			legacyNATTestModules + "modules.dep":     legacyNATTestDep,
		}, legacyNATTestRelease, legacyNATUnloaded},
		{"uncompressed module not loaded", map[string]string{
			legacyNATTestModules + "modules.dep": "kernel/net/ipv4/netfilter/iptable_nat.ko: kernel/net/netfilter/nf_nat.ko\n",
		}, legacyNATTestRelease, legacyNATUnloaded},
		{"kernel ships no module", map[string]string{
			legacyNATTestModules + "modules.builtin": legacyNATTestBuiltin,
			legacyNATTestModules + "modules.dep":     "kernel/net/ipv4/netfilter/ip_tables.ko.zst: kernel/net/netfilter/x_tables.ko.zst\n",
		}, legacyNATTestRelease, legacyNATMissing},
		// Similar names never count as the nat module.
		{"similar names", map[string]string{
			"proc/modules":                           "iptable_natural 12288 0 - Live 0x0\n",
			"proc/net/ip_tables_names":               "natural\n",
			legacyNATTestModules + "modules.builtin": "kernel/net/ipv4/netfilter/iptable_nat_extra.ko\n",
			legacyNATTestModules + "modules.dep":     "kernel/net/ipv4/netfilter/xiptable_nat.ko.zst:\n",
		}, legacyNATTestRelease, legacyNATMissing},
		// Hosts such as NixOS keep modules elsewhere; never fail on them.
		{"no module index", map[string]string{"proc/modules": "nf_tables 380928 0 - Live 0x0\n"}, legacyNATTestRelease, legacyNATUnknown},
		{"no builtin list", map[string]string{
			legacyNATTestModules + "modules.dep": "kernel/net/ipv4/netfilter/ip_tables.ko.zst:\n",
		}, legacyNATTestRelease, legacyNATUnknown},
		{"unusable release", map[string]string{"lib/modules/x/modules.dep": legacyNATTestDep}, "../x", legacyNATUnknown},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := legacyNATTableState(legacyNATTestFiles(test.files), test.release); got != test.want {
				t.Fatalf("got %v, want %v", got, test.want)
			}
		})
	}
}

// legacyNATHost replaces the host root and operating system for one test.
func legacyNATHost(t *testing.T, hostOS string, fsys fs.FS) {
	t.Helper()
	previousFS, previousOS := hostFilesystem, developmentHostOS
	hostFilesystem, developmentHostOS = fsys, hostOS
	t.Cleanup(func() { hostFilesystem, developmentHostOS = previousFS, previousOS })
}

func TestCheckLegacyNATTable(t *testing.T) {
	unloaded := map[string]string{
		legacyNATTestModules + "modules.builtin": legacyNATTestBuiltin,
		legacyNATTestModules + "modules.dep":     legacyNATTestDep,
	}
	dockerKernel := `"info --format {{.KernelVersion}}") echo ` + legacyNATTestRelease + ` ;;
`
	podmanKernel := `"info --format {{.Host.Kernel}}") echo ` + legacyNATTestRelease + ` ;;
`
	for _, test := range []struct {
		name, hostOS, engine, script string
		files                        map[string]string
		wantError, wantWarning       []string
	}{
		{
			name: "unloaded module fails fast", hostOS: "linux", engine: "docker", script: dockerKernel, files: unloaded,
			wantError: []string{"has not loaded the legacy iptables nat table (iptable_nat)", "IPTABLES_MODE=legacy", "sudo modprobe --all iptable_nat iptable_filter iptable_mangle br_netfilter", `"Local K3s cannot load the legacy iptables nat table"`, "troubleshooting.md"},
		},
		{
			name: "Podman on the host kernel", hostOS: "linux", engine: "podman", script: podmanKernel, files: unloaded,
			wantError: []string{"sudo modprobe --all iptable_nat"},
		},
		{
			name: "kernel without the module", hostOS: "linux", engine: "docker", script: dockerKernel,
			files: map[string]string{
				legacyNATTestModules + "modules.builtin": legacyNATTestBuiltin,
				legacyNATTestModules + "modules.dep":     "",
			},
			wantError: []string{"kernel " + legacyNATTestRelease + " provides no legacy iptables nat table"},
		},
		{name: "loaded module", hostOS: "linux", engine: "docker", script: dockerKernel, files: map[string]string{"sys/module/iptable_nat/refcnt": "1\n"}},
		{
			name: "undecidable host only warns", hostOS: "linux", engine: "docker", script: dockerKernel,
			wantWarning: []string{"Warning: could not confirm", "sudo modprobe --all iptable_nat", "troubleshooting.md"},
		},
		// Docker Desktop and Podman machines run the node on another kernel.
		{name: "engine in a VM", hostOS: "linux", engine: "docker", script: `"info --format {{.KernelVersion}}") echo 6.10.14-linuxkit ;;
`, files: unloaded},
		{name: "engine kernel unavailable", hostOS: "linux", engine: "docker", script: `"info --format {{.KernelVersion}}") exit 1 ;;
`, files: unloaded},
		{name: "macOS host", hostOS: "darwin", engine: "docker", script: dockerKernel, files: unloaded},
	} {
		t.Run(test.name, func(t *testing.T) {
			legacyNATHost(t, test.hostOS, legacyNATTestFiles(test.files))
			fakeEngine(t, test.engine, test.script)
			var warnings bytes.Buffer
			r := &runner{engine: test.engine, env: map[string]string{}, opts: Options{Err: &warnings}}
			err := r.checkLegacyNATTable(context.Background())
			if len(test.wantError) == 0 && err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if len(test.wantError) != 0 && err == nil {
				t.Fatal("expected an error")
			}
			for _, want := range test.wantError {
				if !strings.Contains(err.Error(), want) {
					t.Fatalf("error %q does not contain %q", err, want)
				}
			}
			if len(test.wantWarning) == 0 && warnings.Len() != 0 {
				t.Fatalf("unexpected warning: %q", warnings.String())
			}
			for _, want := range test.wantWarning {
				if !strings.Contains(warnings.String(), want) {
					t.Fatalf("warning %q does not contain %q", warnings.String(), want)
				}
			}
		})
	}
}

// The Kubernetes-only profile checks the host before it records state or
// asks k3d for anything.
func TestK3dStartupChecksLegacyNATTableBeforeClusterCreation(t *testing.T) {
	root := t.TempDir()
	state := filepath.Join(root, "state")
	for _, key := range []string{"DOCKER_CONTEXT", "OCC_DEVELOPMENT_CONTROLLER_IMAGE", "OCC_KUBERNETES_RUNTIME_IMAGE", "OCC_DEVELOPMENT_REPOSITORY_INPUT_DIRECTORY", "OCC_DEVELOPMENT_REPOSITORY_IMAGE"} {
		t.Setenv(key, "")
	}
	for key, value := range map[string]string{
		"OCC_DEVELOPMENT_STATE_DIRECTORY":     state,
		"OCC_DEVELOPMENT_KUBERNETES_CLUSTER":  "occ-dev-nat",
		"OCC_DEVELOPMENT_CONTAINER_ENGINE":    "docker",
		"DOCKER_HOST":                         "unix:///fixture/docker.sock",
		"OPENCLAW_DEV_PORT":                   "3000",
		"OCC_DEVELOPMENT_KUBERNETES_API_PORT": "6443",
		"OCC_DEVELOPMENT_BROWSER_PORT":        "8443",
	} {
		t.Setenv(key, value)
	}
	legacyNATHost(t, "linux", legacyNATTestFiles(map[string]string{
		legacyNATTestModules + "modules.builtin": legacyNATTestBuiltin,
		legacyNATTestModules + "modules.dep":     legacyNATTestDep,
	}))
	// PATH contains only fixtures, so no real tool can run.
	t.Setenv("PATH", t.TempDir())
	commands := fakeProfileCommands(t, map[string]string{
		"docker": `"version --format {{json .Server}}") echo '{"Platform":{"Name":"Docker"}}' ;;
"info") ;;
"info --format {{.KernelVersion}}") echo ` + legacyNATTestRelease + ` ;;`,
		"k3d":     "",
		"kubectl": "",
		"helm":    "",
		"node":    "",
		"git":     "",
	})
	err := upK3d(context.Background(), Options{Repository: root}, "none")
	if err == nil || !strings.Contains(err.Error(), "sudo modprobe --all iptable_nat") {
		t.Fatalf("expected the legacy nat table error, got %v", err)
	}
	calls := commands()
	want := []string{"docker version --format {{json .Server}}", "docker info", "docker info --format {{.KernelVersion}}"}
	if strings.Join(calls, "\n") != strings.Join(want, "\n") {
		t.Fatalf("got commands %q, want %q", calls, want)
	}
	if _, err := os.Stat(filepath.Join(state, "state.json")); !os.IsNotExist(err) {
		t.Fatalf("startup recorded state before the preflight: %v", err)
	}
}
