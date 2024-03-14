# EON Zen Tip Bot for Horizen's Discord
This bot allows users to send tips (ZEN on EON) to other users after funding their tip account.

General process:    
 - Discord member requests a deposit address from the tip bot
 - Member sends EON ZEN (eZEN) to the deposit address using Sphere or another method
 - Member may tip another member using the tip bot. Help is available by DMing the bot with: !ezentip help
 - When a member receives a tip, entries are created in the bot's database to track sender and receiver balances.
 - The recipient may tip another member with the tip they received or add more funds.
 - A member may withdraw funds in their tip account at any time.

Note: all funds are stored in the bot's EON address.

Features:

- Tip bot for eZEN. Responds to `!ezentip`.
- Dynamic plugin loading with permission support.
- Send a tip to one other member with optional message
- Send a tip of random amount to one member with optional message
- Send a tip based on fiat currency or other cryptcurrency amount with optional message
- Multiple user support
  - Send either a set amount or a random amount to a channel for the first 20 members who respond
- Admin commands
  - Suspend scheduled background tasks. Usefull when using the payouts command
  - Send a payout to a member bypassing balance checks (runs more quickly)
  - Check balance total of all users and the bot.


## Requirements

- node > 18.19.0
- mongod > 5.0.2


## Installation

Create a bot and get the bot's API Token: https://discordapp.com/developers/applications/me

Connect the bot to a discord server.

Edit, update and rename example.default.js in /config to default.js
  - enter the bot token and the server id.
  - change the 'debug' and 'testnet' to false for production. 'debug' can be left true if logging is needed.
  - enter the EON address and private key of the bot.
  - update default max tip (number) and gas price (string) if needed. Note: gas and gas price is fixed so transfers and withdrawls include all funds.
  - change the mongodb settings. No options are needed for the listed versions dependencies. The database is created when started.
  - enter the moderation role and logchannel id.
  - enter a list of admin ids.    

Make sure you have mongod running,
then run:
```
npm install
node bot/bot.js
```

or for production:    
set the environment variable NODE_ENV=production
```
npm run prod
```


## Credits

Based on the original work https://github.com/lbryio/lbry-tipbot from filipnyquist <filip@lbry.io>

## Changes
### 2024-03:
 - New instance (rewrite and repo) of the tipbot for Zen on the EON sidechain. This version does not support Zen on the horizen mainchain.
 - Added support for a username or tag as text in addition to a user object in some tip commands.
 - Added a checkbals admin command that returns the total balance of all accounts and the current balance of the bot account.
 - Skip responding to @everyone and @here mentions.
 - Updated dependencies    


