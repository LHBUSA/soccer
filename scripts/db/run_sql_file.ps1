# Run SQL from a FILE on the SPORTS project via the Supabase Management API
# (no 32 KB command-line limit). Token: Windows Credential Manager
# "Supabase CLI:supabase" — never printed. Same behaviour as
# D:\Workers\ufc-propbetedge\scripts\db\run_sql.ps1, which takes -Query.
#   pwsh scripts/db/run_sql_file.ps1 -File path/to/file.sql
param([Parameter(Mandatory = $true)][string]$File)
$ErrorActionPreference = "Stop"
$sig = @'
using System; using System.Runtime.InteropServices;
public class CredMan4 {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct CREDENTIAL { public int Flags; public int Type; public string TargetName; public string Comment; public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist; public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName; }
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool CredRead(string target, int type, int flags, out IntPtr cred);
  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr cred);
  public static string Read(string target) { IntPtr p; if (!CredRead(target, 1, 0, out p)) return null; var c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL)); var b = new byte[c.CredentialBlobSize]; Marshal.Copy(c.CredentialBlob, b, 0, b.Length); CredFree(p); return System.Text.Encoding.UTF8.GetString(b); }
}
'@
if (-not ([System.Management.Automation.PSTypeName]'CredMan4').Type) { Add-Type -TypeDefinition $sig }
$tok = [CredMan4]::Read("Supabase CLI:supabase")
if (-not $tok) { throw "Supabase CLI token not found" }
$ref = "tkmlnhmylqnttmnsnief"
$payload = @{ query = (Get-Content -Raw $File) } | ConvertTo-Json -Depth 3 -Compress
try {
  $r = Invoke-RestMethod -Method Post -Uri "https://api.supabase.com/v1/projects/$ref/database/query" -Headers @{ Authorization = "Bearer $tok"; "Content-Type" = "application/json" } -Body $payload
  if ($null -eq $r) { "(empty result)" } else { $r | ConvertTo-Json -Depth 4 }
} catch {
  $msg = $_.ErrorDetails.Message; if (-not $msg) { $msg = $_.Exception.Message }
  "FAILED -> $msg"
}
