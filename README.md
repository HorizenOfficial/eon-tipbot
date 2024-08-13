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
  - Send one or more payouts to a member bypassing balance checks (runs more quickly)
  - Check balance total of all users and the bot. Optional list all user balances.


## Requirements

- node > 18.19.0
- mongod > 5.0.2


## Installation

Create a bot and get the bot's API Token: https://discordapp.com/developers/applications/me

Connect the bot to a discord server.

Make a copy of example.default.js and name it default.js
  - EONBOT_CFGPATH environment variable may be used to specify the full file and path. Default is the config folder.
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
### 2024-06
  - Update URLs for api servers.
  - Added optional env config file path.
  - Updated init sequence to ensure db connection before sweeping funds.
  - Updates to some logging to include more specific error causes
  - Added return of unknown member account for admin rather than failing bot command
### 2024-03:
 - New instance (rewrite and repo) of the tipbot for Zen on the EON sidechain. This version does not support Zen on the horizen mainchain.
 - Added support for a username or tag as text in addition to a user object in some tip commands.
 - Added a checkbals admin command that returns the total balance of all accounts and the current balance of the bot account.
 - Skip responding to @everyone and @here mentions.
 - Updated dependencies    

&nbsp;
&nbsp;
&nbsp;
&nbsp;
## Sample Docker-compose file
version: "3"

services:    
&nbsp;&nbsp;&nbsp;&nbsp;eonzentipbot:    
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;restart: always    
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;image: eontipbot:latest    
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;container_name: ezenbot    
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;stop_grace_period: 1m    
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;volumes:    
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;- "/mnt/tipbot/eonbotconfig/:/config/"    
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;environment:    
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;- "EONBOT_CFGPATH=/config/default.js"    
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;network_mode: "host"    
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;tmpfs:    
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;- /run    
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;- /tmp    
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;logging:    
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;driver: "json-file"    
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;options:    
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;max-size: "512m"    
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;max-file: "4"    



