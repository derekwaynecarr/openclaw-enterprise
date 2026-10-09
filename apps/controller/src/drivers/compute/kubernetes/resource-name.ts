/**
 * A Kubernetes resource name: a DNS subdomain of at most 253 characters.
 * The Compute driver applies this to gateway routing names and namespaces.
 */
const KUBERNETES_RESOURCE_NAME =
  /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;

export function isKubernetesResourceName(value: string): boolean {
  return value.length <= 253 && KUBERNETES_RESOURCE_NAME.test(value);
}
