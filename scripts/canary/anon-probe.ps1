# Browser-equivalent probe: reads the SPORTS project's public anon key via the Supabase
# Management API (token from Windows Credential Manager "Supabase CLI:supabase"; neither key is
# printed) and tries to read the private shadow tables through PostgREST exactly as a browser could.
# Prints only HTTP status and row counts.
#   pwsh scripts/canary/anon-probe.ps1
$ErrorActionPreference = "Stop"
$sig = @'
using System; using System.Runtime.InteropServices;
public class CredMan5 {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct CREDENTIAL { public int Flags; public int Type; public string TargetName; public string Comment; public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist; public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName; }
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool CredRead(string target, int type, int flags, out IntPtr cred);
  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr cred);
  public static string Read(string target) { IntPtr p; if (!CredRead(target, 1, 0, out p)) return null; var c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL)); var b = new byte[c.CredentialBlobSize]; Marshal.Copy(c.CredentialBlob, b, 0, b.Length); CredFree(p); return System.Text.Encoding.UTF8.GetString(b); }
}
'@
if (-not ([System.Management.Automation.PSTypeName]'CredMan5').Type) { Add-Type -TypeDefinition $sig }
$tok = [CredMan5]::Read("Supabase CLI:supabase")
if (-not $tok) { throw "Supabase CLI token not found" }
$ref = "tkmlnhmylqnttmnsnief"
$keys = Invoke-RestMethod -Uri "https://api.supabase.com/v1/projects/$ref/api-keys" -Headers @{ Authorization = "Bearer $tok" }
$anon = ($keys | Where-Object { $_.name -eq "anon" } | Select-Object -First 1).api_key
if (-not $anon) { throw "anon key not found" }
$out = @()
foreach ($t in @("soccer_model_shadow_predictions", "soccer_model_shadow_events", "soccer_model_shadow_metrics")) {
  $status = $null; $rows = $null
  try {
    $r = Invoke-WebRequest -Uri "https://$ref.supabase.co/rest/v1/${t}?select=*&limit=5" -Headers @{ apikey = $anon; Authorization = "Bearer $anon" } -SkipHttpErrorCheck
    $status = [int]$r.StatusCode
    if ($status -eq 200) { $rows = @($r.Content | ConvertFrom-Json).Count }
  } catch { $status = "error: $($_.Exception.Message)" }
  $out += [pscustomobject]@{ table = $t; http_status = $status; rows_visible = $rows; readable = ($status -eq 200 -and $rows -gt 0) }
}
$out | ConvertTo-Json -Compress
