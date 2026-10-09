import { createHash } from "node:crypto";
import type { AgentOptions } from "node:https";
import type {
  Cluster,
  KubeConfig,
  ObservableMiddleware,
  RequestContext,
  ResponseContext,
} from "@kubernetes/client-node";
import { Agent, type buildConnector, type Dispatcher } from "undici";
import { currentComputeAbortSignal } from "../compute/operation-context.ts";
import type { KubernetesAuthentication } from "./authentication.ts";

type KubernetesSdk = typeof import("@kubernetes/client-node");

type KubernetesClientConfiguration = ReturnType<
  typeof import("@kubernetes/client-node").createConfiguration
>;

type ValidationFailure = (message: string) => Error;

export async function createKubernetesClientConfiguration(
  authentication: KubernetesAuthentication,
  validationFailure: ValidationFailure,
): Promise<{
  readonly sdk: KubernetesSdk;
  readonly clientConfiguration: KubernetesClientConfiguration;
  readonly kubeConfig: import("@kubernetes/client-node").KubeConfig;
  readonly server: string;
}> {
  let sdk: KubernetesSdk;
  try {
    sdk = await import("@kubernetes/client-node");
  } catch {
    throw validationFailure("The Kubernetes client package is unavailable.");
  }

  const configuration = new sdk.KubeConfig();
  reuseRequestDispatcher(configuration);
  if (authentication.mode === "inCluster") {
    configuration.loadFromCluster();
  } else {
    configuration.loadFromFile(authentication.kubeconfigPath);
    const contexts = configuration
      .getContexts()
      .filter((context) => context.name === authentication.context);
    const selected = contexts[0];
    if (contexts.length !== 1 || selected === undefined) {
      throw validationFailure(
        "The kubeconfig must contain exactly one explicitly requested context.",
      );
    }
    if (
      configuration.getClusters().filter((cluster) => cluster.name === selected.cluster).length !==
      1
    ) {
      throw validationFailure("The explicit context must select exactly one Kubernetes cluster.");
    }
    configuration.setCurrentContext(authentication.context);
    if (configuration.getCurrentContext() !== authentication.context) {
      throw validationFailure("The requested Kubernetes context could not be selected.");
    }
  }

  const cluster = configuration.getCurrentCluster();
  if (cluster === null || configuration.getCurrentUser() == null) {
    throw validationFailure("The selected Kubernetes cluster or credential identity is missing.");
  }
  let endpoint: URL;
  try {
    endpoint = new URL(cluster.server);
  } catch {
    throw validationFailure("The selected Kubernetes API server URL is invalid.");
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.pathname !== "/" ||
    endpoint.search ||
    endpoint.hash ||
    cluster.skipTLSVerify === true
  ) {
    throw validationFailure(
      "The Kubernetes API server must use verified HTTPS and configured trust roots.",
    );
  }

  const cancellationMiddleware: ObservableMiddleware = {
    pre(request: RequestContext) {
      const signal = currentComputeAbortSignal();
      if (signal !== undefined) {
        signal.throwIfAborted();
        request.setSignal(signal);
      }
      return new sdk.Observable(Promise.resolve(request));
    },
    post(response: ResponseContext) {
      return new sdk.Observable(Promise.resolve(response));
    },
  };
  const clientConfiguration = sdk.createConfiguration({
    baseServer: new sdk.ServerConfiguration(cluster.server, {}),
    authMethods: { default: configuration },
    middleware: [cancellationMiddleware],
  });
  return { sdk, clientConfiguration, kubeConfig: configuration, server: cluster.server };
}

/** The private KubeConfig method that builds each API request's dispatcher. */
type KubeConfigDispatcherFactory = {
  createDispatcher(cluster: Cluster | null, agentOptions: AgentOptions): Dispatcher | undefined;
};

/**
 * @kubernetes/client-node 2.0.0 builds a new undici Agent for every API request
 * (`applySecurityAuthentication` calls `createDispatcher` each time), so every
 * request opened its own TLS connection, which then idled about four seconds
 * before closing. A busy process held a connection per recent request and paid
 * a TLS handshake for each call (finding 890). This keeps one dispatcher per
 * KubeConfig and reuses it while the TLS material is unchanged. When that
 * material changes (a rotated client certificate or CA), it builds a new
 * dispatcher and closes the old one once its in-flight requests finish.
 * Requests use HTTP/1.1, as before 2.0.0: undici would otherwise negotiate
 * HTTP/2 and multiplex every call over one shared connection.
 */
export function reuseRequestDispatcher(configuration: KubeConfig): void {
  const factory = configuration as unknown as KubeConfigDispatcherFactory;
  if (typeof factory.createDispatcher !== "function") {
    throw new Error("The Kubernetes client no longer exposes its request dispatcher factory.");
  }
  const createLibraryDispatcher = factory.createDispatcher.bind(configuration);
  let current: { readonly fingerprint: string; readonly dispatcher: Dispatcher } | undefined;
  factory.createDispatcher = (cluster, agentOptions) => {
    const options = configuration.createDispatcherOptions(cluster, agentOptions);
    if (options.type === "none") {
      return undefined;
    }
    const fingerprint = createHash("sha256").update(JSON.stringify(options)).digest("hex");
    if (current?.fingerprint === fingerprint) {
      return current.dispatcher;
    }
    const dispatcher =
      options.type === "agent"
        ? new Agent({
            allowH2: false,
            // The same options client-node passes to this constructor; its
            // tls.ConnectionOptions type is only looser about optional fields.
            connect: options.connect as Partial<buildConnector.BuildOptions>,
          })
        : createLibraryDispatcher(cluster, agentOptions);
    if (dispatcher === undefined) {
      return undefined;
    }
    const previous = current?.dispatcher;
    current = { fingerprint, dispatcher };
    previous?.close().catch(() => undefined);
    return dispatcher;
  };
}

/**
 * The Kubernetes API server did not answer (connection refused, reset, or timed
 * out). It names only the endpoint so startup logs can say which dependency and
 * address failed without exposing credentials or client error objects.
 */
export class KubernetesApiUnavailableError extends Error {
  readonly host: string;
  readonly port: number;

  constructor(server: string, options?: ErrorOptions) {
    const endpoint = new URL(server);
    const host = endpoint.hostname.replace(/^\[(.*)\]$/, "$1");
    const port = endpoint.port === "" ? 443 : Number(endpoint.port);
    super(`The Kubernetes API server at ${host}:${port} is unreachable.`, options);
    this.name = "KubernetesApiUnavailableError";
    this.host = host;
    this.port = port;
  }
}
