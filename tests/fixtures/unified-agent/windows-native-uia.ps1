$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false, $true)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false, $true)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class KiteNativeUIA {
 [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
 [DllImport("kernel32.dll", SetLastError=true)] public static extern bool CloseHandle(IntPtr handle);
 [DllImport("kernel32.dll")] public static extern uint WaitForSingleObject(IntPtr handle, uint ms);
 [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetProcessTimes(IntPtr h, out long creation, out long exit, out long kernel, out long user);
 [DllImport("kernel32.dll", EntryPoint="QueryFullProcessImageNameW", ExactSpelling=true, CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool QueryFullProcessImageName(IntPtr h, uint flags, StringBuilder path, ref uint size);
 public delegate bool EnumProc(IntPtr h, IntPtr p);
 [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr p);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
 [StructLayout(LayoutKind.Sequential)] public struct KEY { public ushort vk, scan; public uint flags, time; public UIntPtr extra; }
 [StructLayout(LayoutKind.Explicit)] public struct UNION { [FieldOffset(0)] public KEY key; [FieldOffset(0)] public long mouse0; [FieldOffset(8)] public long mouse1; [FieldOffset(16)] public long mouse2; [FieldOffset(24)] public long mouse3; }
 [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public UNION data; }
 [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint count, INPUT[] inputs, int size);
 public static void UnicodeText(string text) {
  foreach(char c in text) {
   var a = new INPUT[2]; a[0].type=1; a[0].data.key.scan=c; a[0].data.key.flags=4;
   a[1]=a[0]; a[1].data.key.flags=6;
   if(SendInput(2,a,Marshal.SizeOf(typeof(INPUT)))!=2) throw new Exception("uia_send_input_failed");
  }
 }
 public static IntPtr Window(uint pid) {
  IntPtr found=IntPtr.Zero; int count=0;
  EnumWindows((h,p)=> {uint actual; GetWindowThreadProcessId(h,out actual); if(actual==pid && IsWindowVisible(h)){found=h;count++;} return true;},IntPtr.Zero);
  if(count!=1) throw new Exception("uia_original_window_not_unique"); return found;
 }
}
'@
function Fail([string]$code) { throw $code }
function Verify-Original($h, $r) {
 if ([KiteNativeUIA]::WaitForSingleObject($h, 0) -ne 258) { Fail 'uia_original_process_not_alive' }
 [long]$born=0; [long]$exit=0; [long]$kernel=0; [long]$user=0
 if (-not [KiteNativeUIA]::GetProcessTimes($h,[ref]$born,[ref]$exit,[ref]$kernel,[ref]$user) -or $born.ToString() -cne $r.creationTime) { Fail 'uia_original_birth_changed' }
 $path=New-Object System.Text.StringBuilder 32768; [uint32]$length=32768
 if (-not [KiteNativeUIA]::QueryFullProcessImageName($h,0,$path,[ref]$length) -or -not [string]::Equals($path.ToString(),$r.executablePath,[StringComparison]::OrdinalIgnoreCase)) { Fail 'uia_original_image_changed' }
}
function Describe($e) {
 $c=$e.Current
 $row=@{runtimeId=@($e.GetRuntimeId());name=$c.Name;controlType=$c.ControlType.ProgrammaticName;automationId=$c.AutomationId;enabled=$c.IsEnabled;offscreen=$c.IsOffscreen}
 $pattern=$null
 if ($e.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern,[ref]$pattern)) { $row.text=$pattern.DocumentRange.GetText(-1) }
 $pattern=$null
 if ($e.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern,[ref]$pattern)) { $row.value=$pattern.Current.Value }
 foreach($field in @('name','text','value')) { if ($row.ContainsKey($field) -and $row[$field].Length -gt 2097152) { Fail 'uia_full_property_too_large' } }
 return $row
}
function Find-Named($root,$r) {
 $found=@(); $all=$root.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
 if ($all.Count -gt 512) { Fail 'uia_tree_too_large' }
 $regex=$null
 if ($r.match -eq 'regex') { $regex=[System.Text.RegularExpressions.Regex]::new($r.name,[System.Text.RegularExpressions.RegexOptions]::CultureInvariant,[TimeSpan]::FromMilliseconds(100)) }
 foreach($e in $all) {
  if (-not (($null -eq $regex -and $e.Current.Name -ceq $r.name) -or ($null -ne $regex -and $regex.IsMatch($e.Current.Name)))) { continue }
  if (-not $e.Current.IsEnabled -or $e.Current.IsOffscreen) { continue }
  $pattern=$null; $eligible=$false
  if ($r.action -eq 'clickByName') {
   $eligible=$e.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern,[ref]$pattern)
  } elseif ($r.action -eq 'fillByName') {
   if ($e.Current.ControlType -ne [System.Windows.Automation.ControlType]::Edit -or -not $e.Current.IsKeyboardFocusable) { continue }
   $eligible=$e.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern,[ref]$pattern)
   if (-not $eligible) { $pattern=$null; $eligible=$e.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern,[ref]$pattern) }
  } elseif ($r.action -eq 'fileMenu') {
   if ($e.Current.ControlType -ne [System.Windows.Automation.ControlType]::MenuItem) { continue }
   $eligible=$e.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern,[ref]$pattern)
   if (-not $eligible) { $pattern=$null; $eligible=$e.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern,[ref]$pattern) }
  }
  if ($eligible) { $found+=,$e }
 }
 if ($found.Count -ne 1) { Fail 'uia_named_element_not_unique' }
 return $found[0]
}
function Invoke-Element($e) {
 if (-not $e.Current.IsEnabled -or $e.Current.IsOffscreen) { Fail 'uia_element_not_actionable' }
 $pattern=$null
 if (-not $e.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern,[ref]$pattern)) { Fail 'uia_invoke_pattern_missing' }
 $pattern.Invoke()
}
[Console]::WriteLine('{"ready":true}')
while ($null -ne ($line=[Console]::ReadLine())) {
 $id=$null; $h=[IntPtr]::Zero; $failure=$null; $result=$null
 try {
  if ($line.Length -gt 1048576) { Fail 'uia_request_too_large' }
  $r=$line | ConvertFrom-Json; $id=$r.id
  $keys=@($r.PSObject.Properties.Name)
  foreach($key in $keys) { if ($key -notin @('id','pid','creationTime','executablePath','action','name','match','text')) { Fail 'uia_request_unknown_field' } }
  if ($id -isnot [string] -or $id -notmatch '^[a-f0-9]{32}$' -or $r.pid -lt 1 -or $r.pid -gt 4294967295 -or $r.creationTime -isnot [string] -or $r.creationTime -notmatch '^[0-9]{1,20}$' -or $r.executablePath -isnot [string] -or $r.executablePath.Length -gt 32768 -or -not [IO.Path]::IsPathRooted($r.executablePath)) { Fail 'uia_identity_invalid' }
  if ($r.action -notin @('snapshot','clickByName','fillByName','quit')) { Fail 'uia_action_invalid' }
  if ($r.action -in @('clickByName','fillByName')) { if ($r.name -isnot [string] -or $r.name.Length -lt 1 -or $r.name.Length -gt 256 -or $r.match -notin @('exact','regex')) { Fail 'uia_selector_invalid' } }
  if ($r.action -eq 'fillByName' -and ($r.text -isnot [string] -or $r.text.Length -gt 65536)) { Fail 'uia_text_invalid' }
  $h=[KiteNativeUIA]::OpenProcess(0x101000,$false,[uint32]$r.pid)
  if ($h -eq [IntPtr]::Zero) { Fail 'uia_original_process_unavailable' }
  Verify-Original $h $r
  $window=[KiteNativeUIA]::Window([uint32]$r.pid)
  $root=[System.Windows.Automation.AutomationElement]::FromHandle($window)
  if ($root.Current.ProcessId -ne $r.pid) { Fail 'uia_window_identity_changed' }
  if ($r.action -eq 'snapshot') {
   $all=$root.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
   if ($all.Count -eq 0) { Fail 'uia_tree_missing' }
   if ($all.Count -gt 512) { Fail 'uia_tree_too_large' }
   $rows=@(); foreach($e in $all) { Verify-Original $h $r; $rows+=,(Describe $e) }
   if (@($rows | Where-Object { $_.controlType -eq 'ControlType.Document' }).Count -eq 0) { Fail 'uia_content_tree_missing' }
   $result=@{elements=$rows}
  } elseif ($r.action -eq 'quit') {
   $file=Find-Named $root @{name='^(File|文件)(\(&F\))?$';match='regex';action='fileMenu'}
   Verify-Original $h $r
   $expand=$null
   if ($file.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern,[ref]$expand)) { $expand.Expand() } else { Invoke-Element $file }
   # The native menu popup may be a desktop child; only accept items whose kernel HWND belongs to this original Main.
   $menus=[System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children,[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ProcessIdProperty,[int]$r.pid))
   $choices=@(); foreach($menu in $menus) {
    $items=$menu.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::MenuItem))
    foreach($item in $items) {
     if ($item.Current.Name -notmatch '^(Quit|Exit|退出)(\([&A-Z]\))?(\s+.*)?$' -or -not $item.Current.IsEnabled -or $item.Current.IsOffscreen) { continue }
     $invoke=$null
     if (-not $item.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern,[ref]$invoke)) { continue }
     $duplicate=$false
     foreach($choice in $choices) { if ([System.Windows.Automation.Automation]::Compare($choice,$item)) { $duplicate=$true; break } }
     if (-not $duplicate) { $choices+=,$item }
    }
   }
   if ($choices.Count -ne 1) { Fail 'uia_quit_menu_not_unique' }
   Verify-Original $h $r; Invoke-Element $choices[0]; $result=@{quitRequested=$true}
  } else {
   $e=Find-Named $root $r; Verify-Original $h $r
   if ($r.action -eq 'clickByName') { $before=Describe $e; Invoke-Element $e; $result=@{invoked=$before} }
   else {
    if (-not $e.Current.IsEnabled -or -not $e.Current.IsKeyboardFocusable -or $e.Current.IsOffscreen) { Fail 'uia_input_not_actionable' }
    $pattern=$null
    if ($e.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern,[ref]$pattern) -and -not $pattern.Current.IsReadOnly) { $pattern.SetValue($r.text) }
    else {
     if (-not [KiteNativeUIA]::SetForegroundWindow($window)) { Fail 'uia_foreground_failed' }
     $e.SetFocus(); Verify-Original $h $r
     if (-not [System.Windows.Automation.Automation]::Compare($e,[System.Windows.Automation.AutomationElement]::FocusedElement)) { Fail 'uia_focus_changed' }
     $old=Describe $e
     if (($old.ContainsKey('text') -and $old.text -ne '') -or ($old.ContainsKey('value') -and $old.value -ne '')) { Fail 'uia_keyboard_input_not_empty' }
     [KiteNativeUIA]::UnicodeText($r.text)
    }
    Verify-Original $h $r; $actual=Describe $e
    if (($actual.ContainsKey('value') -and $actual.value -ceq $r.text) -or ($actual.ContainsKey('text') -and $actual.text -ceq $r.text)) { $result=@{filled=$r.text;element=$actual} } else { Fail 'uia_full_input_mismatch' }
   }
  }
 } catch { $failure=$_.Exception.Message }
 finally { if ($h -ne [IntPtr]::Zero -and -not [KiteNativeUIA]::CloseHandle($h)) { if ($null -ne $failure) { $failure += '; uia_original_handle_close_unknown' } else { $failure='uia_original_handle_close_unknown' } } }
 if ($null -ne $failure) { $response=@{id=$id;error=$failure} } else { $response=@{id=$id;result=$result} }
 $json=$response | ConvertTo-Json -Compress -Depth 12
 if ($json.Length -gt 8388608) { $json=@{id=$id;error='uia_full_snapshot_too_large'} | ConvertTo-Json -Compress }
 [Console]::WriteLine($json)
}
