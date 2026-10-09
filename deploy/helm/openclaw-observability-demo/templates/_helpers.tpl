{{- define "demo.labels" -}}
app.kubernetes.io/name: openclaw-observability-demo
app.kubernetes.io/instance: {{ .root.Release.Name | quote }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}
{{- define "demo.validate" -}}
{{- $_ := required "occ.namespace is required" .Values.occ.namespace -}}
{{- $_ := required "occ.release is required" .Values.occ.release -}}
{{- $_ := required "grafana.adminSecretName must name an existing private Secret" .Values.grafana.adminSecretName -}}
{{- if empty .Values.cluster.cidrs }}{{ fail "cluster.cidrs must identify Kubernetes API endpoints" }}{{ end -}}
{{- range .Values.cluster.cidrs }}
{{- if not (regexMatch "^[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+/32$" .) }}{{ fail "cluster.cidrs requires exact IPv4 /32 endpoints" }}{{ end -}}
{{- end -}}
{{- range $name, $image := .Values.images }}
{{- if not (regexMatch "^[^[:space:]@]+@sha256:[a-f0-9]{64}$" $image) }}{{ fail (printf "images.%s must use an immutable SHA-256 reference" $name) }}{{ end -}}
{{- end -}}
{{- range .Values.grafana.clients }}
{{- if or (empty .namespace) (empty .podLabels) }}{{ fail "grafana.clients requires namespace and nonempty podLabels" }}{{ end -}}
{{- end -}}
{{- end -}}

{{- /* Service names are DNS labels, while Helm permits dots and leading digits in release names. Keep admissible short names stable and hash the original release whenever normalization or shortening is needed. */ -}}
{{- define "demo.serviceName" -}}
{{- $name := printf "%s-%s" .root.Release.Name .component -}}
{{- if and (le (len $name) 63) (regexMatch "^[a-z]([-a-z0-9]*[a-z0-9])?$" $name) -}}
{{- $name -}}
{{- else -}}
{{- $prefix := replace "." "-" .root.Release.Name -}}
{{- if not (regexMatch "^[a-z]" $prefix) -}}{{- $prefix = printf "demo-%s" $prefix -}}{{- end -}}
{{- $suffix := printf "-%s-%s" (.root.Release.Name | sha256sum | trunc 12) .component -}}
{{- printf "%s%s" ($prefix | trunc (int (sub 63 (len $suffix))) | trimSuffix "-") $suffix -}}
{{- end -}}
{{- end -}}
