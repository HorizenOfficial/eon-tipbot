/*  Optional settings and updates.
botcfg
  sweepIntervalMs - optional - defaults to 24 hours if not present. Enter as number in milliseconds
     sweepfunds runs only to catch deposits when a user has not sent a check balance to trigger a zen transaction.
     sweepfunds will run on bot startup and then every interval  
  sweepSuspendMs - optional - defaults to 1 hour if not present.  Enter as number in milliseconds
     used by admin to keep a sweep from running while processing payouts.
  debugLog - true/false  log to console. Not overly verbose for small user base. May be enabled for production
  includeDateInConsoleLog - true/false  include UTC datetime in debugLog.
  testnet - true/false

ezencfg
  private key and address for the bot's EON Zen address
  explorer and RPC provider URLs
  maximum tip amount in eZen. Number
  gasPrice for each deposit or withdrawl. String in wei. "20000000000" results in fees of eon default of 0.0042 zen. 
    Note: fees are static rather than dynamic to allow the full balance to be calculated prior to a transaction for transfers to bot and account withdrawl.

mongodb
  url - should be a unique database.  include '?authSource=admin' or whatever the authentication database is auth enabled
  urlTest - use a different database name if testnet is true in botcfg
  options - configuration to override mongodb if needed.

moderation
  role - optional - user must have this role to use bot.  Leave blank if everyone can use it
  logchannel - optional - channel to receive limited log messages. Currently: when sweep funds is suspended; summary of a payout.
    Leave blank or delete to disable

admins
  optional list (array) of user ids which allows users to use admin methods of suspend, payouts, check balances.

*/


exports.Config = {
  "botcfg": {
    "token":"DISCORD TOKEN HERE",
    "serverId": "SERVER ID HERE",
    "prefix": "!",
    "debug": true,
    "includeDateInConsoleLog": true,
    "testnet": true,
   // "sweepIntervalMs": 60 * 60 * 1000,  // once per hour  default once per day
   // "sweepSuspendMs": 3600000, // 1 hour - default
  },
  "ezencfg": {
    "priv":"EON ZEN PRIVATE KEY",
    "address":"BOT'S EON ZEN ADDRESS",
    "mainExplorerURL": "https://eon-explorer.horizenlabs.io/",
    "testExplorerURL": "https://gobi-explorer.horizenlabs.io/",
    "mainAPIExpURL": "https://eon-explorer-api.horizenlabs.io/api/v2/",
    "testAPIExpURL": "https://gobi-explorer-api.horizenlabs.io/api/v2/",
    "mainRPCURL": "https://eon-rpc.horizenlabs.io/ethv1",
    "testRPCURL": "https://gobi-rpc.horizenlabs.io/ethv1",
    "maxTip": 1,
    "gasPrice": "10000000000"
  },
  "mongodb": {
    "urlTest":"mongodb://mongodb-tipbot:27017/ezentipbotTest?authSource=admin",
    "url":"mongodb://localhost:27017/ezentipbot?authSource=admin",
    "options": {
    }
  },
  "moderation":{
    "role": "ALLOWED ROLE ID",
    "logchannel": "LOG CHANNEL ID"
  },
  "admins": ["USER ID", "USER ID 2"]
}
