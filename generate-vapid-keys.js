// Generate once on your computer: npm run generate:vapid
// Copy the printed values to Render Environment. Never commit the private key.
const crypto = require('crypto');
const keys = crypto.createECDH('prime256v1');
keys.generateKeys();
console.log('VAPID_PUBLIC_KEY=' + keys.getPublicKey().toString('base64url'));
console.log('VAPID_PRIVATE_KEY=' + keys.getPrivateKey().toString('base64url'));
