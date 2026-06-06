param(
  [string]$ConfigPath = "config/rpa-control-panel.json",
  [switch]$ValidateOnly
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$Script:Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Script:Root

function Resolve-RepoPath {
  param([Parameter(Mandatory = $true)][string]$PathValue)

  if ([System.IO.Path]::IsPathRooted($PathValue)) {
    return $PathValue
  }

  return [System.IO.Path]::GetFullPath((Join-Path $Script:Root $PathValue))
}

function Get-ConfigValue {
  param(
    [object]$Object,
    [string]$Name,
    [object]$DefaultValue
  )

  if ($null -eq $Object) {
    return $DefaultValue
  }

  $property = $Object.PSObject.Properties[$Name]
  if ($null -ne $property -and $null -ne $property.Value) {
    return $property.Value
  }

  return $DefaultValue
}

function Get-ConfigBool {
  param(
    [object]$Object,
    [string]$Name,
    [bool]$DefaultValue
  )

  $value = Get-ConfigValue $Object $Name $null
  if ($null -eq $value) {
    return $DefaultValue
  }

  return [System.Convert]::ToBoolean($value)
}

function Append-Log {
  param([string]$Message)

  $timestamp = Get-Date -Format "HH:mm:ss"
  if ($null -ne $Script:LogBox) {
    $Script:LogBox.AppendText("[$timestamp] $Message`r`n")
  }
}

function Show-PanelError {
  param([object]$ErrorObject)

  $message = $ErrorObject.Exception.Message
  Append-Log "ERROR: $message"
  [System.Windows.Forms.MessageBox]::Show($message, "RPA Control Panel", "OK", "Error") | Out-Null
}

function ConvertTo-PowerShellSingleQuotedLiteral {
  param([Parameter(Mandatory = $true)][string]$Value)

  return "'$($Value.Replace("'", "''"))'"
}

function Start-HiddenPowerShellCommand {
  param([Parameter(Mandatory = $true)][string]$Command)

  $encodedCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($Command))
  Start-Process -FilePath "powershell" -ArgumentList @(
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    $encodedCommand
  ) -WorkingDirectory $Script:Root -WindowStyle Hidden
}

function Invoke-NodeJson {
  param([string[]]$Arguments)

  $output = & $Script:NodeCommand @Arguments 2>&1
  $exitCode = $LASTEXITCODE
  $text = ($output | ForEach-Object { $_.ToString() }) -join [Environment]::NewLine

  if ($exitCode -ne 0) {
    throw "Command failed: $Script:NodeCommand $($Arguments -join ' ')`r`n$text"
  }
  if ([string]::IsNullOrWhiteSpace($text)) {
    return $null
  }

  return $text | ConvertFrom-Json
}

function Get-LatestConfigPath {
  param([string]$Port)

  return "output/run_configs/gui_${Port}_latest.yaml"
}

function New-RunConfig {
  param(
    [object]$Worker,
    [System.Windows.Forms.TextBox]$StartTaskBox,
    [System.Windows.Forms.TextBox]$TaskFileBox,
    [System.Windows.Forms.NumericUpDown]$PageLimitBox,
    [System.Windows.Forms.CheckBox]$StopAtLimitBox
  )

  $portId = [string](Get-ConfigValue $Worker "id" (Get-ConfigValue $Worker "port" ""))
  $stopAtLimit = if ($StopAtLimitBox.Checked) { "true" } else { "false" }
  $arguments = @(
    $Script:HelperScript,
    "make-run-config",
    "--config",
    $Script:ConfigPath,
    "--port-id",
    $portId,
    "--start-task",
    $StartTaskBox.Text.Trim(),
    "--task-file",
    $TaskFileBox.Text.Trim(),
    "--page-limit",
    ([string][int]$PageLimitBox.Value),
    "--stop-on-page-limit",
    $stopAtLimit
  )

  return Invoke-NodeJson $arguments
}

function Start-CdpBrowser {
  param([object]$Worker)

  $port = [string](Get-ConfigValue $Worker "port" (Get-ConfigValue $Worker "id" "9222"))
  $profile = [string](Get-ConfigValue $Worker "profile" "D:/chrome-rpa-profile")
  $scriptPath = Resolve-RepoPath $Script:ChromeLaunchScript
  if (-not (Test-Path $scriptPath)) {
    throw "Chrome launch script not found: $scriptPath"
  }

  $command = "& $(ConvertTo-PowerShellSingleQuotedLiteral $scriptPath) -Port $(ConvertTo-PowerShellSingleQuotedLiteral $port) -UserDataDir $(ConvertTo-PowerShellSingleQuotedLiteral $profile)"
  Start-HiddenPowerShellCommand $command

  Append-Log "Port $port browser open requested with profile $profile"
}

function Start-NodeCliProcess {
  param(
    [string]$Mode,
    [object]$Plan
  )

  $configPath = [string]$Plan.configPath
  $runId = [string]$Plan.runId
  New-Item -ItemType Directory -Force -Path (Resolve-RepoPath "logs") | Out-Null

  if ($Mode -eq "run") {
    $stdoutPath = Resolve-RepoPath ([string]$Plan.stdoutLog)
    $stderrPath = Resolve-RepoPath ([string]$Plan.stderrLog)
  } else {
    $stdoutPath = Resolve-RepoPath "logs/${runId}.${Mode}.stdout.log"
    $stderrPath = Resolve-RepoPath "logs/${runId}.${Mode}.stderr.log"
  }

  $process = Start-Process -FilePath $Script:NodeCommand -ArgumentList @(
    $Script:CliScript,
    "-c",
    $configPath,
    $Mode
  ) -WorkingDirectory $Script:Root -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -WindowStyle Hidden -PassThru

  return [pscustomobject]@{
    Pid = $process.Id
    Stdout = $stdoutPath
    Stderr = $stderrPath
  }
}

function Get-RunnerPids {
  param([string]$ConfigPathValue)

  $result = Invoke-NodeJson @(
    $Script:HelperScript,
    "runner-pids",
    "--config-path",
    $ConfigPathValue
  )

  return @($result.pids)
}

function Format-Status {
  param([object]$Status)

  $lines = New-Object System.Collections.Generic.List[string]
  $counts = @()
  if ($null -ne $Status.latestStatusCounts) {
    foreach ($property in $Status.latestStatusCounts.PSObject.Properties) {
      $counts += "$($property.Name)=$($property.Value)"
    }
  }
  if ($counts.Count -eq 0) {
    $countsText = "none"
  } else {
    $countsText = $counts -join ", "
  }

  $pids = @($Status.activeRunnerPids)
  if ($pids.Count -eq 0) {
    $pidText = "none"
  } else {
    $pidText = $pids -join ", "
  }

  $lines.Add("config: $($Status.configPath)")
  $lines.Add("runner pids: $pidText")
  $lines.Add("pages: $($Status.accountedPages) used, $($Status.remainingPages) remaining")
  $lines.Add("latest statuses: $countsText")

  if ($null -ne $Status.currentOrLastStarted) {
    $started = $Status.currentOrLastStarted
    $lines.Add("last started: $($started.taskId) $($started.company) at $($started.ts)")
  }
  if ($null -ne $Status.lastRun) {
    $last = $Status.lastRun
    $lines.Add("last run log: $($last.level) $($last.message) $($last.taskId) $($last.reason) $($last.error)")
  }
  if ($null -ne $Status.latestTaskFolders) {
    $folders = $Status.latestTaskFolders
    $lines.Add("folders: $($folders.nonEmpty) non-empty, $($folders.empty) empty")
  }
  if ($null -ne $Status.warningsOrErrors -and @($Status.warningsOrErrors).Count -gt 0) {
    $lines.Add("recent warnings/errors:")
    foreach ($warning in @($Status.warningsOrErrors)) {
      $lines.Add("  $($warning.ts) $($warning.level) $($warning.message) $($warning.taskId) $($warning.reason) $($warning.error)")
    }
  }

  return $lines -join [Environment]::NewLine
}

function New-LabeledControl {
  param(
    [string]$Label,
    [System.Windows.Forms.Control]$Control,
    [int]$Width
  )

  $panel = New-Object System.Windows.Forms.Panel
  $panel.Width = $Width
  $panel.Height = 48

  $labelControl = New-Object System.Windows.Forms.Label
  $labelControl.Text = $Label
  $labelControl.Location = New-Object System.Drawing.Point(0, 0)
  $labelControl.Size = New-Object System.Drawing.Size($Width, 18)

  $Control.Location = New-Object System.Drawing.Point(0, 20)
  $Control.Width = $Width

  $panel.Controls.Add($labelControl)
  $panel.Controls.Add($Control)
  return $panel
}

function New-WorkerGroup {
  param([object]$Worker)

  $port = [string](Get-ConfigValue $Worker "port" (Get-ConfigValue $Worker "id" ""))
  $defaultStartTask = [string](Get-ConfigValue $Worker "defaultStartTask" "T0002")
  $defaultTaskFile = [string](Get-ConfigValue $Worker "taskFile" $Script:DefaultTaskFile)
  $defaultPageLimit = [int](Get-ConfigValue $Worker "dailyPageLimit" $Script:DefaultPageLimit)
  $defaultStop = Get-ConfigBool $Worker "stopOnPageLimit" $Script:DefaultStopOnPageLimit
  $state = [ordered]@{
    LatestConfigPath = Get-LatestConfigPath $port
  }

  $group = New-Object System.Windows.Forms.GroupBox
  $group.Text = "Port $port"
  $group.Width = 1120
  $group.Height = 158

  $flow = New-Object System.Windows.Forms.FlowLayoutPanel
  $flow.Dock = "Fill"
  $flow.FlowDirection = "LeftToRight"
  $flow.WrapContents = $true
  $flow.Padding = New-Object System.Windows.Forms.Padding(8)

  $startTaskBox = New-Object System.Windows.Forms.TextBox
  $startTaskBox.Text = $defaultStartTask

  $taskFileBox = New-Object System.Windows.Forms.TextBox
  $taskFileBox.Text = $defaultTaskFile

  $pageLimitBox = New-Object System.Windows.Forms.NumericUpDown
  $pageLimitBox.Minimum = 1
  $pageLimitBox.Maximum = 100000
  $pageLimitBox.Value = $defaultPageLimit

  $stopAtLimitBox = New-Object System.Windows.Forms.CheckBox
  $stopAtLimitBox.Text = "Stop at limit"
  $stopAtLimitBox.Checked = $defaultStop
  $stopAtLimitBox.Width = 110
  $stopAtLimitBox.Height = 42

  $openButton = New-Object System.Windows.Forms.Button
  $openButton.Text = "Open CDP"
  $openButton.Width = 92
  $openButton.Height = 42

  $inspectButton = New-Object System.Windows.Forms.Button
  $inspectButton.Text = "Inspect"
  $inspectButton.Width = 86
  $inspectButton.Height = 42

  $startButton = New-Object System.Windows.Forms.Button
  $startButton.Text = "Start Run"
  $startButton.Width = 88
  $startButton.Height = 42

  $statusButton = New-Object System.Windows.Forms.Button
  $statusButton.Text = "Status"
  $statusButton.Width = 78
  $statusButton.Height = 42

  $stopButton = New-Object System.Windows.Forms.Button
  $stopButton.Text = "Stop Node"
  $stopButton.Width = 92
  $stopButton.Height = 42

  $openButton.Add_Click({
    try {
      Start-CdpBrowser $Worker
    } catch {
      Show-PanelError $_
    }
  }.GetNewClosure())

  $inspectButton.Add_Click({
    try {
      $plan = New-RunConfig $Worker $startTaskBox $taskFileBox $pageLimitBox $stopAtLimitBox
      $state.LatestConfigPath = [string]$plan.latestConfigPath
      $started = Start-NodeCliProcess "inspect" $plan
      Append-Log "Port $port inspect started: PID $($started.Pid); stdout $($started.Stdout)"
    } catch {
      Show-PanelError $_
    }
  }.GetNewClosure())

  $startButton.Add_Click({
    try {
      $plan = New-RunConfig $Worker $startTaskBox $taskFileBox $pageLimitBox $stopAtLimitBox
      $state.LatestConfigPath = [string]$plan.latestConfigPath
      $runningPids = Get-RunnerPids $state.LatestConfigPath
      if ($runningPids.Count -gt 0) {
        Append-Log "Port $port already has runner PID(s): $($runningPids -join ', ')"
        return
      }

      $started = Start-NodeCliProcess "run" $plan
      Append-Log "Port $port run started: PID $($started.Pid); first $($plan.firstSelectedTask); selected $($plan.selectedTasks); stdout $($started.Stdout)"
    } catch {
      Show-PanelError $_
    }
  }.GetNewClosure())

  $statusButton.Add_Click({
    try {
      $configPath = [string]$state.LatestConfigPath
      if ([string]::IsNullOrWhiteSpace($configPath)) {
        $configPath = Get-LatestConfigPath $port
      }
      $status = Invoke-NodeJson @(
        $Script:HelperScript,
        "status",
        "--config-path",
        $configPath
      )
      Append-Log (Format-Status $status)
    } catch {
      Show-PanelError $_
    }
  }.GetNewClosure())

  $stopButton.Add_Click({
    try {
      $configPath = [string]$state.LatestConfigPath
      if ([string]::IsNullOrWhiteSpace($configPath)) {
        $configPath = Get-LatestConfigPath $port
      }
      $runnerPids = Get-RunnerPids $configPath
      if ($runnerPids.Count -eq 0) {
        Append-Log "Port $port has no matching node runner"
        return
      }

      foreach ($processId in $runnerPids) {
        Stop-Process -Id ([int]$processId) -Force -ErrorAction Stop
      }
      Append-Log "Port $port stopped node runner PID(s): $($runnerPids -join ', ')"
    } catch {
      Show-PanelError $_
    }
  }.GetNewClosure())

  $flow.Controls.Add((New-LabeledControl "Start task" $startTaskBox 82))
  $flow.Controls.Add((New-LabeledControl "Task file" $taskFileBox 330))
  $flow.Controls.Add((New-LabeledControl "Pages" $pageLimitBox 76))
  $flow.Controls.Add($stopAtLimitBox)
  $flow.Controls.Add($openButton)
  $flow.Controls.Add($inspectButton)
  $flow.Controls.Add($startButton)
  $flow.Controls.Add($statusButton)
  $flow.Controls.Add($stopButton)

  $group.Controls.Add($flow)
  return $group
}

$Script:ConfigPath = Resolve-RepoPath $ConfigPath
$Script:Config = Get-Content -Path $Script:ConfigPath -Raw | ConvertFrom-Json
$Script:NodeCommand = [string](Get-ConfigValue $Script:Config "nodeCommand" "node")
$Script:CliScript = [string](Get-ConfigValue $Script:Config "cliScript" "dist/src/cli.js")
$Script:ChromeLaunchScript = [string](Get-ConfigValue $Script:Config "chromeLaunchScript" "scripts/start-chrome-cdp.ps1")
$Script:HelperScript = "scripts/rpa-control-helper.mjs"
$Script:DefaultTaskFile = [string](Get-ConfigValue $Script:Config "defaultTaskFile" "lseg_request_by_call_2015_2018_end_plus_7d.txt")
$Script:DefaultPageLimit = [int](Get-ConfigValue $Script:Config "dailyPageLimit" 700)
$Script:DefaultStopOnPageLimit = Get-ConfigBool $Script:Config "stopOnPageLimit" $true

[System.Windows.Forms.Application]::EnableVisualStyles()

$form = New-Object System.Windows.Forms.Form
$form.Text = "RPA Control Panel"
$form.StartPosition = "CenterScreen"
$form.Size = New-Object System.Drawing.Size(1180, 720)
$form.MinimumSize = New-Object System.Drawing.Size(980, 540)

$main = New-Object System.Windows.Forms.TableLayoutPanel
$main.Dock = "Fill"
$main.ColumnCount = 1
$main.RowCount = 3
$main.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 42))) | Out-Null
$main.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Percent, 58))) | Out-Null
$main.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Percent, 42))) | Out-Null

$header = New-Object System.Windows.Forms.Label
$header.Text = "RPA Control Panel"
$header.Dock = "Fill"
$header.Font = New-Object System.Drawing.Font("Segoe UI", 12, [System.Drawing.FontStyle]::Bold)
$header.Padding = New-Object System.Windows.Forms.Padding(10, 8, 0, 0)

$workersPanel = New-Object System.Windows.Forms.FlowLayoutPanel
$workersPanel.Dock = "Fill"
$workersPanel.AutoScroll = $true
$workersPanel.FlowDirection = "TopDown"
$workersPanel.WrapContents = $false
$workersPanel.Padding = New-Object System.Windows.Forms.Padding(10, 4, 10, 4)

$Script:LogBox = New-Object System.Windows.Forms.TextBox
$Script:LogBox.Dock = "Fill"
$Script:LogBox.Multiline = $true
$Script:LogBox.ReadOnly = $true
$Script:LogBox.ScrollBars = "Both"
$Script:LogBox.WordWrap = $false
$Script:LogBox.Font = New-Object System.Drawing.Font("Consolas", 9)

foreach ($worker in @($Script:Config.ports)) {
  $workersPanel.Controls.Add((New-WorkerGroup $worker))
}

$resizeWorkerGroups = {
  $targetWidth = [Math]::Max(760, $workersPanel.ClientSize.Width - 30)
  foreach ($control in $workersPanel.Controls) {
    if ($control -is [System.Windows.Forms.GroupBox]) {
      $control.Width = $targetWidth
    }
  }
}.GetNewClosure()

$workersPanel.Add_Resize($resizeWorkerGroups)
& $resizeWorkerGroups

$main.Controls.Add($header, 0, 0)
$main.Controls.Add($workersPanel, 0, 1)
$main.Controls.Add($Script:LogBox, 0, 2)
$form.Controls.Add($main)

Append-Log "Loaded config $Script:ConfigPath"
if ($ValidateOnly) {
  Write-Output "ok"
  return
}

[System.Windows.Forms.Application]::Run($form)
