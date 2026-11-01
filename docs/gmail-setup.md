# Connect Gmail — one-time setup

Google only lets an app use Gmail if it's registered in Google Cloud. You do this **once**, as the developer. After that, connecting is just "Sign in with Google → Allow".

Takes about 10 minutes. It's free.

## 1. Create a project

1. Open **https://console.cloud.google.com** and sign in with your Google account.
2. Click the project picker at the top → **New project**.
3. Name it `Unified AI Base` → **Create**. Make sure it's selected at the top afterwards.

## 2. Turn on the Gmail API

1. In the search bar at the top, type **Gmail API** and open it.
2. Click **Enable**.

## 3. Set up the sign-in screen

1. In the search bar, type **Google Auth Platform** (older name: *OAuth consent screen*) and open it.
2. Click **Get started**:
   - **App name:** `Unified AI Base`
   - **User support email:** your email
   - **Audience:** **External**
   - **Contact information:** your email
   - Agree to the policy → **Create**.

## 4. Add yourself as a test user

While the app is in *testing* mode, only people on this list can sign in (up to 100).

1. In Google Auth Platform, open **Audience**.
2. Under **Test users** → **Add users** → enter your Gmail address → **Save**.

## 5. Add the Gmail permissions

1. Open **Data access** → **Add or remove scopes**.
2. Scroll to **Manually add scopes** and paste:
   ```
   https://www.googleapis.com/auth/gmail.readonly
   https://www.googleapis.com/auth/gmail.compose
   ```
3. **Add to table** → **Update** → **Save**.

These let the app **read** mail and **create drafts / send**. It can't delete mail or change your settings.

## 6. Create the app's credentials

1. Open **Clients** → **Create client**.
2. **Application type:** **Desktop app**. Name: `Unified AI Base desktop` → **Create**.
3. Copy the **Client ID** (ends in `.apps.googleusercontent.com`) and the **Client secret**.

## 7. Connect in the app

1. In Unified AI Base, open **Services** → **Gmail**.
2. Paste the Client ID and Client secret → **Save**. (The secret goes into your Mac's Keychain.)
3. Click **Connect Gmail**. Your browser opens Google's sign-in page.
4. Google will say **"Google hasn't verified this app"** — that's expected in testing mode. Click **Continue**.
5. Tick the permissions → **Continue**. You'll see "Gmail is connected". Go back to the app.

## Try it

- "Any unread emails from this week?"
- "What did the last email from HR say?"
- "Draft a reply to Priya saying I'll send it tomorrow"
- "Send the Q3 report to sam@example.com" — the kernel asks before sending.

## Notes

- **Disconnect** any time under Services, or at **myaccount.google.com/permissions**.
- **Sign-in expires after 7 days** while the Google project is in testing mode. Just click **Connect Gmail** again.
- **Before sharing with the public**, Google requires a verification and security review for apps that read Gmail. Testing mode is fine for you and up to 100 people you add.
