$envPath = Join-Path $PSScriptRoot ".env"

if (-not (Test-Path $envPath)) {
    Write-Error "فایل .env پیدا نشد!"
    exit 1
}

# Read .env
$envVars = @{}
Get-Content $envPath | ForEach-Object {
    $line = $_.Trim()
    if ($line -and -not $line.StartsWith("#")) {
        $parts = $line.Split("=", 2)
        if ($parts.Length -eq 2) {
            $envVars[$parts[0].Trim()] = $parts[1].Trim()
        }
    }
}

$tgcloudToken = $envVars["TGCLOUD_TOKEN"]
if (-not $tgcloudToken) {
    Write-Error "لطفاً TGCLOUD_TOKEN را در فایل .env وارد کنید!"
    exit 1
}

$serverlessDir = Join-Path $PSScriptRoot "serverless"

Write-Host "🚀 در حال اتصال به کلاود سرورلس تلگرام و ساخت جداول دیتابیس..." -ForegroundColor Cyan
docker run --rm -v "${serverlessDir}:/app" -w /app -e "TGCLOUD_TOKEN=$tgcloudToken" node:22-alpine npx --yes tgcloud migrate

Write-Host "📤 در حال آپلود و استقرار کدهای سرورلس..." -ForegroundColor Cyan
docker run --rm -v "${serverlessDir}:/app" -w /app -e "TGCLOUD_TOKEN=$tgcloudToken" node:22-alpine npx --yes tgcloud push

Write-Host "✅ با موفقیت روی سرورلس تلگرام مستقر شد!" -ForegroundColor Green
