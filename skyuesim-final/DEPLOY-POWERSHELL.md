# Deploy from PowerShell

## 1. Configure production services

Configure all secret values directly in the protected Environment settings of the backend host. Never place a real `.env` file, API key, password or webhook secret in GitHub or in the deployment ZIP.

Required before accepting payments:

- persistent PostgreSQL `DATABASE_URL`;
- live Stripe secret, prices and webhook secret;
- eSIM Access credentials with `ESIM_MOCK_MODE=false`;
- verified Resend sender and webhook secret;
- long random auth, recovery, backup and security secrets;
- VAPID keys when push notifications are enabled.

Configure these webhook URLs:

- Stripe: `https://YOUR-BACKEND/api/webhook`;
- Resend inbound: `https://YOUR-BACKEND/api/inbound-email`.

Enable Stripe Customer Portal in the Stripe Dashboard before users open the billing screen.

## 2. Verify locally

```powershell
Set-Location 'C:\path\to\skyuesim'
powershell.exe -ExecutionPolicy Bypass -File .\deploy.ps1
```

## 3. Commit and push

If Render and Netlify are connected to the `main` branch, this command verifies, commits and pushes the revision, which triggers both deployments:

```powershell
powershell.exe -ExecutionPolicy Bypass -File .\deploy.ps1 -Push
```

Use a custom commit message when needed:

```powershell
powershell.exe -ExecutionPolicy Bypass -File .\deploy.ps1 -Push -CommitMessage 'Deploy Signal eSIM production release'
```

## 4. Post-deploy smoke test

1. Open `/api/service-status` and confirm the backend responds.
2. Register a fresh test account and verify the email-change code flow.
3. Complete one Stripe test checkout and confirm the order tracker reaches `eSIM ready`.
4. Deliver the same Stripe test event twice and confirm the second response contains `duplicate: true`.
5. Open `payments.html`, enter Stripe Customer Portal, then return to the application.
6. Recover an existing test eSIM and confirm no new provider order is created.
7. Create and reply to a support ticket by email.
