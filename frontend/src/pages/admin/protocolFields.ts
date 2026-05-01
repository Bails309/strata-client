// Protocol field registry for the connection editor form.
//
// Each connection protocol declares which top-level fields make sense for
// it. The form reads this registry at render time so adding a new protocol
// (or changing what an existing one needs) is a one-line edit here rather
// than a tangle of `protocol === 'web' || protocol === 'vdi'` checks
// scattered through the JSX.
//
// Why is this a registry and not inline conditions?
//   - We have 5 protocols today (rdp/ssh/vnc/web/vdi) and may add more
//     (kubernetes, telnet) in future. Inline conditions don't scale.
//   - The default-port mapping was previously duplicated inside the
//     onChange handler; centralising it here keeps the source of truth
//     in one place.
//   - Hiding fields that the backend ignores prevents operators from
//     filling in a hostname that has no wire-level effect, which has
//     been a recurring source of confusion (see git log around v0.30.0).

export type ProtocolKey = "rdp" | "ssh" | "vnc" | "web" | "vdi" | "kubernetes";

export interface ProtocolDescriptor {
  /** Wire value stored in `connections.protocol`. */
  value: ProtocolKey;
  /** Human label for the dropdown. */
  label: string;
  /** Initial port populated when the operator picks this protocol. */
  defaultPort: number;
  /** Show the top-level **Hostname** field on the connection editor. */
  showHostname: boolean;
  /** Show the top-level **Port** field on the connection editor. */
  showPort: boolean;
  /** Show the top-level **Domain** (Kerberos realm) field. */
  showDomain: boolean;
}

export const PROTOCOLS: ProtocolDescriptor[] = [
  // Full network target — connect by IP/hostname to an external box.
  {
    value: "rdp",
    label: "RDP",
    defaultPort: 3389,
    showHostname: true,
    showPort: true,
    showDomain: true,
  },
  {
    value: "ssh",
    label: "SSH",
    defaultPort: 22,
    showHostname: true,
    showPort: true,
    showDomain: true,
  },
  {
    value: "vnc",
    label: "VNC",
    defaultPort: 5900,
    showHostname: true,
    showPort: true,
    showDomain: true,
  },
  // Strata-spawned local workloads — backend allocates a localhost
  // VNC display (`web`) or talks to a managed Docker container
  // (`vdi`). The hostname/port/domain trio is structurally meaningless
  // for these and was actively confusing operators, so the form hides
  // them. Defaults are kept harmless for any operator who downgrades a
  // connection from these protocols back to rdp/ssh/vnc.
  {
    value: "web",
    label: "Web Browser",
    defaultPort: 5900,
    showHostname: false,
    showPort: false,
    showDomain: false,
  },
  {
    value: "vdi",
    label: "VDI Desktop",
    defaultPort: 3389,
    showHostname: false,
    showPort: false,
    showDomain: false,
  },
  // Kubernetes pod console (`kubectl attach`/`exec` rendered through guacd's
  // kubernetes protocol). Hostname is the K8s API server, port is the API
  // port (typically 6443 for kubeadm clusters, 8080 for unsecured local
  // dev). Domain has no meaning here.
  {
    value: "kubernetes",
    label: "Kubernetes Pod",
    defaultPort: 6443,
    showHostname: true,
    showPort: true,
    showDomain: false,
  },
];

/** Lookup helper. Falls back to RDP if the key is unknown (defensive — should not happen). */
export function protocolDescriptor(key: string): ProtocolDescriptor {
  return PROTOCOLS.find((p) => p.value === key) ?? PROTOCOLS[0];
}
