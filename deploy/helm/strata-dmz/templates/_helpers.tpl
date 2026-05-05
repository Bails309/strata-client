{{/* Common helpers */}}

{{- define "strata-dmz.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "strata-dmz.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name (include "strata-dmz.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "strata-dmz.labels" -}}
app.kubernetes.io/name: {{ include "strata-dmz.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{- end -}}

{{- define "strata-dmz.selectorLabels" -}}
app.kubernetes.io/name: {{ include "strata-dmz.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "strata-dmz.image" -}}
{{- $tag := default .Chart.AppVersion .Values.image.tag -}}
{{ printf "%s:%s" .Values.image.repository $tag }}
{{- end -}}

{{- define "strata-dmz.secretName" -}}
{{- if .Values.secrets.existingSecret -}}
{{ .Values.secrets.existingSecret }}
{{- else -}}
{{ include "strata-dmz.fullname" . }}-secrets
{{- end -}}
{{- end -}}
