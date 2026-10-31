# OGGY SHOPIFY WEB

**Dev TG:** [t.me/oggyproo](https://t.me/oggyproo)

A full-stack Shopify card checking platform with global site & proxy rotation.

## Features
- **Global Sites:** Admin adds sites once, used by all users
- **Global Proxies:** Auto-checked live proxies, randomly rotated per card
- **Admin Panel:** User management, activity logs, inbox
- **No CORS issues:** Backend proxies the API call

## Default Admin Login
- Email: `yousafcodes.de@gmail.com`
- Password: `YOUSAFCODES.DE`

## Deploy on Render
1. Push this folder to a GitHub repo
2. Create a **New Web Service** on Render
3. Connect the repo
4. **Build Command:** `npm install`
5. **Start Command:** `node index.js`
6. Deploy!

## Setup After Deploy
1. Login as admin
2. Go to **Config** → add your sites (comma separated)
3. Paste proxies → click **Check & Save Live Proxies**
4. Done! Users can now run the checker

## Dev
Made with ❤️ by [t.me/oggyproo](https://t.me/oggyproo)
