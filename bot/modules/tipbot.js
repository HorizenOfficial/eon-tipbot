'use strict';

const cfgPath = process.env.EONBOT_CFGPATH || '../../config/default.js'
const { Config } = require('' + cfgPath);
const mongoose = require('mongoose');
const axios = require('axios');
const { ethers, toBigInt } = require('ethers');

const { moderation, mongodb, admins, ezencfg, botcfg } = Config

const sweepInterval = botcfg.sweepIntervalMs || 60 * 60 * 24 * 1000;
let sweepSuspend = botcfg.sweepSuspendMs || 60 * 60 * 1000;
let lastSuspend = new Date();
// adjust so initial sweep runs on start
lastSuspend = new Date(lastSuspend - sweepSuspend);
// validation for 1-100
const regSuspend = /^[1-9]$|^[1-9][0-9]$|^(100)$/;
const includetimestamp = botcfg.includeDateInConsoleLog;

// Set up bot wallet
const EON_RPC = botcfg.testnet ? ezencfg.testRPCURL : ezencfg.mainRPCURL;
let connection;
let botWallet;
try {
  connection = new ethers.JsonRpcProvider(EON_RPC);
  botWallet = new ethers.Wallet(ezencfg.priv, connection);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}

// Set up API
const EON_EXPLORER = botcfg.testnet ? ezencfg.testExplorerURL : ezencfg.mainExplorerURL;
const EON_API = botcfg.testnet ? ezencfg.testAPIExpURL : ezencfg.mainAPIExpURL;
const axiosApi = axios.create({
  baseURL: EON_API,
  timeout: 10000,
});

const GAS_LIMIT = 21000n; // sending to another account will always be 21000 gas
const GAS_PRICE = ezencfg.gasPrice ? toBigInt(ezencfg.gasPrice) : 20000000000n; // must be at least the base which is the default here.
const TX_COST = (GAS_LIMIT * GAS_PRICE);
const MAX_TIP = ezencfg.maxTip || 1;

// Set up mongodb
const dbConnection = botcfg.testnet ? mongodb.urlTest : mongodb.url;
debugLog(dbConnection)
let db;
let User;
async function initMongo() {
  try {
    await mongoose.connect(dbConnection);
    db = mongoose.connection;
    db.on('error', console.error.bind(console, 'connection error: '));
    db.once('open', function () {
      console.log("Mongodb: connected to '" + this.host + '/' + this.name + "'!");
    });
    User = db.model('User', userSchema);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}


const userSchema = mongoose.Schema({
  id: String,
  priv: String,
  address: String,
  phrase: String,
  deposited: String,
  spent: String,
  received: String,
});

// object to track transfers in and out of bot account in case there are
// multiple requests within one block.
const pendingTxs = {};

function isAdmin(discordId) {
  if (!admins) return false;
  return admins.includes(discordId);
}

exports.commands = ['ezentip'];

exports.ezentip = {
  usage: '<subcommand>',

  description:
    'Here are the commands you can use:\n' +
    '**!ezentip help** : display this message.\n' +
    '**!ezentip deposit** : get an address to top up your balance.\n' +
    '**!ezentip balance** : get your balance.\n' +
    '**!ezentip withdraw <amount> <address>** : withdraw <amount> eZEN from your' +
    ' balance to your <address>.\n' +
    '**!ezentip <@user> <amount> [message]** : tip <@user> <amount> eZEN (maximum' +
    ' 1 eZEN) and leave an optional [message].\n' +
    '**!ezentip each <amount> <n> [message]** : drop a eZEN packet in a channel, the' +
    ' <amount> is divided *equally* between the <n> first people to open' +
    ' the eZEN packet. Leave an optional [message] with the eZEN packet.\n' +
    '**!ezentip luck <amount> <n> [message]** : drop a eZEN packet in a channel, the' +
    ' <amount> is divided *randomly* between the <n> first people to open' +
    ' the eZEN packet. Leave an optional [message] with the eZEN packet.\n' +
    '**!ezentip open** : open the latest eZEN packet dropped into the channel.\n',

  process: async function (bot, msg) {
    try {
      const { err, user } = await getUser(msg.author.id, bot, true)

      if (err) return debugLog(err);
      const tipper = user;
      tipper.isAdmin = isAdmin(user.id);
      const words = msg.content
        .trim()
        .split(' ')
        .filter(function (n) {
          return n !== '';
        });
      const subcommand = words.length >= 2 ? words[1] : 'help';

      switch (subcommand) {
        case 'help':
          doHelp(msg, tipper, words);
          break;

        case 'balance':
          doBalance(msg, tipper, words);
          break;

        case 'deposit':
          doDepositAddr(msg, tipper);
          break;

        case 'withdraw':
          doWithdraw(msg, tipper, words);
          break;

        case 'each':
          createTipEach(msg, tipper, words);
          break;

        case 'luck':
          createTipLuck(msg, tipper, words);
          break;

        case 'open':
          // tipper is actually receiver in this case
          doOpenTip(msg, tipper, words, bot);
          break;

        case 'suspend':
          suspend(msg, tipper, words, bot);
          break;

        case 'payout':
          doPayout(msg, tipper, words, bot);
          break;

        case 'multipay':
          doMultiPayout(msg, tipper, words, bot);
          break;

        case 'checkbals':
          checkBalances(msg, tipper, words, bot);
          break;

        default:
          doTip(msg, tipper, words, bot);
      }
      // });
    } catch (error) {
      console.error(error);
    }
  },
};


// array of active open tips
const tipAllChannels = [];
let currencyHelp;
// default currencies if coingecko fails initial request
let allowedFiatCurrencySymbols = [
  'usd',
  'eur',
  'rub',
  'jpy',
  'gbp',
  'aud',
  'brl',
  'cad',
  'chf',
  'clp',
  'cny',
  'czk',
  'dkk',
  'hkd',
  'idr',
  'ils',
  'inr',
  'krw',
  'mxn',
  'myr',
  'nok',
  'nzd',
  'php',
  'pkr',
  'pln',
  'sek',
  'sgd',
  'thb',
  'try',
  'twd',
  'zar',
];

/**
 * 
 * @param {Message}  message discord message object
 * @param {User} tipper person sending the command 
 * @param {array} words bot arguments sent 
 * @returns 
 */
function doHelp(message, tipper, words) {
  if (message.channel.type !== 1) {
    return message.reply('send me this command in a direct message!');
  }
  if (!words || words.length < 3) {
    message.author.send(
      'Here are the commands you can use for your account and to tip a single user:\n' +
      '**!ezentip help** : display this message.\n\n' +
      '**!ezentip deposit** : get an address to top up your balance. ' +
      '(note that a gas fees will be applied to your deposit)\n' +
      '`Warning:` Staking your `ezentip-bot-address` is ' +
      "not possible (You won't be able to use these eZEN outside this tip bot)!\n\n" +
      '**!ezentip balance** : get your balance. If incorrect and you recently made a deposit, ' +
      'please wait for the next block and check again\n\n' +
      '**!ezentip balance <currency_ticker>** : get your balance in another currency. Supported currencies: !ezentip help currency\n\n' +
      '**!ezentip withdraw <amount> <address>** : withdraw <amount> (or use `all` as <amount> ) eZEN from ' +
      'your balance to your `eZEN` <address> (Only eZEN addresses are supported!).\n\n' +
      '**!ezentip <@user> <amount> [message]** : tip <@user> <amount> eZEN. ' +
      'Maximum tip has to be less than or equal to 1 eZEN.\n\n' +
      '**!ezentip <@user> random [message]** : tip <@user> random eZEN where ' +
      'random is greater than 0.0 and less than 0.1)\n\n' +
      '**!ezentip <@user> <amount><currency_ticker> [message]** : tip ' +
      '<@user> eZEN in currency equivalent. Example: **!ezentip @lukas 200czk** (_no space between amount and ticker_). ' +
      'You can use <currency_ticker> with every send tip command. Supported currencies: !ezentip help currency\n\n'
    );

    message.author.send(
      'Commands for multiple users.\n' +
      'The following applies to _luck_ and _each_:  Only one eZEN packet per channel is ' +
      'allowed. Maximum is 20 people. Your eZEN packet will be active for the next ' +
      '20 minutes, after that it can be overwritten by a new eZEN packet. Maximum tip has to be ≤ 1 eZEN.\n\n' +
      '**!ezentip luck <amount> <n> [message]** : drop a eZEN packet in a channel, ' +
      'the <amount> is divided *randomly* (one tip is bigger, you can win ' +
      'the jackpot) between the <n> first people to open the eZEN packet. Leave an ' +
      'optional [message] with the eZEN packet.\n\n' +
      '**!ezentip each <amount> <n> [message]** : drop a eZEN packet in a channel, ' +
      'the <amount> is divided *equally* between the <n> first people to ' +
      'open the eZEN packet. Leave an optional [message] with the eZEN packet.\n\n'
    );
  }

  if (tipper.isAdmin && (words.length === 2 || words.length > 2 && words[2] === 'admin')) {
    message.author.send(
      'These are the **admin commands** you can use:\n' +
      '**!ezentip suspend [30] ** : suspend scheduled background tasks for indicated minutes (default one hour) while doing payouts. ' +
      'Optional minutes must be between 1 and 100 and is saved for next time (unless tipbot is restarted). \n\n' +
      '**!ezentip payout <@user> <amount><fiat_currency_ticker> [message]** : send a tip to a someone who has completed a task. ' +
      'Be sure your balance is sufficient for the total of all payouts to be made since ' +
      'your balance check is skipped when using this command. Supports the same arguments as !ezentip @<user>.\n\n' +
      '**!ezentip multipay <amounttoeach> @name1 @name2 @name3 @morenames [message]** : send the tip amount to each user listed by their @name. ' +
      'The tipper\'s balance and each name is checked before sending. Any text after last @name is sent as a message to each user. \n\n' +
      '**!ezentip checkbals [list]** returns the total net balance of all the user accounts and the balance of the bot. Include "list" ' +
      'for individual user balances.'
    );
  }

  if (words && words[2]) {
    if (words[2] === 'currency') {
      message.author.send('Supported currencies (fiat and coins): \n\n' +
        `${currencyHelp ? currencyHelp : allowedFiatCurrencySymbols.toString().replace(/,/g, ', ')}\n`);
    } else if (words[2] !== 'admin') {
      message.author.send(`Unknown help: ${words[2]}. Available help: currency`);
    }
  }
}

/**
 * 
 * @param {string} id discord id
 * @param {bot} bot 
 * @param {user} disordUser optional. user from cache or member.user 
 * @returns the displayed username
 */
async function getName(id, bot, discordUser) {
  try {
    const member = discordUser || await bot.guilds.cache.get(botcfg.serverId).members.fetch(id);
    return Promise.resolve(member.globalName || member.tag || member.user.globalName || member.user.tag);
  } catch (error) {
    const errMsg = `ERROR id ${id}: ${error.message || error}`
    debugLog(errMsg)
    return Promise.resolve(errMsg)
  }
}

/**
 * 
 * @param {string} id 
 * @param {Bot} bot 
 * @param {boolean} doName get the user name or tag if true
 * @returns {err, user}  user is from local database
 */
async function getUser(id, bot, doName) {
  //  default user
  const user = new User({
    id: id,
    priv: '',
    address: '',
    phrase: '',
    deposited: '0',
    spent: '0',
    received: '0',
  });

  // check for user in DB
  const userDb = await User.findOne({ id: id }).exec();

  if (userDb) {
    // Existing User
    if (doName) {
      const name = await getName(id, bot);
      // the error is likely "Unknown Member" if not found in the guild.
      userDb.name = name.includes('ERROR') ? name.substring(name.indexOf(':') + 2) : name;
    }
    return Promise.resolve({ err: null, user: userDb });
  } else {
    // New User account
    const acc = ethers.Wallet.createRandom();
    user.priv = acc.privateKey;
    user.address = acc.address;
    user.phrase = acc.mnemonic.phrase;

    const newUser = await user.save()
    if (user != newUser) {
      return Promise.resolve((new Error(`user with address ${user.address} was not added to the database`), null));
    }
    if (doName) user.name = await getName(id, bot);
    return Promise.resolve({ err: null, user });
  }
}

/**
 * 
 * @param {User} user 
 * @returns Promise for balance info object {err, balance, balanceBI}
 */
async function getBalance(user) {
  const balBI = await botWallet.provider.getBalance(user.address);
  const result = { err: null, balance: null, balanceBI: null };
  if (balBI >= 0n) {
    if (balBI > (2n * TX_COST)) {
      transferToBot(user, balBI);
    }
    const tipBalBI = balBI + toBigInt(user.deposited) + toBigInt(user.received) - toBigInt(user.spent);
    const balance = Number(tipBalBI) / 1e18;
    result.balance = balance;
    result.balanceBI = tipBalBI;
  } else {
    result.err = "Balance not returned";
  }
  return Promise.resolve(result)
}

/**
 * Reply to !ezentip balance and display user's balance.
 * DO NOT CONFUSE WITH getBalance!
 * @param message
 * @param tipper
 */
async function doBalance(message, tipper, words) {
  if (message.channel.type !== 1) {
    return message.reply('send me this command in a direct message!');
  }

  const balInfo = await getBalance(tipper);
  if (balInfo.err) {
    debugLog(balInfo.err);
    return message.reply('error getting balance!');
  }
  if (words.length > 2 && allowedFiatCurrencySymbols.includes(words[2].toLowerCase())) {
    getFiatToZenEquivalent(balInfo.balance, words[2], true, function (err, value) {
      if (err) {
        message.reply(`Error getting currency rate for ${words[2]}`);
        return;
      }
      message.reply(`You have **${value} ${words[2]}**  (${balInfo.balance} eZEN)`);
      return;
    });
  } else {
    message.reply(`You have **${balInfo.balance}** eZEN`);
  }
}

/**
 * 
 * @param {Message} message 
 * @param {User} tipper 
 * @returns  message to user with the deposit address
 */
function doDepositAddr(message, tipper) {
  if (message.channel.type !== 1) {
    return message.reply('send me this command in a direct message!');
  }
  message.reply('**WARNING: do not stake/forge with this address, your eZEN is consolidated' +
    ' in the bot !**\n\n' + 'Your deposit address is: ' + tipper.address);
}

/**
 * Calculate equivalent of ZEN in given currency.
 * @param amount - float - given in specific currency
 * @param fiatCurrencySymbol - string - fiat currency ticker
 * @param zentofiat - boolean - calculate zen to fiat for doBalance
 * @param cb
 */
function getFiatToZenEquivalent(amount, fiatCurrencySymbol, zentofiat, cb) {
  const BASE_API_URL = 'https://api.coingecko.com/api/v3/coins/zencash/market_chart';
  const API_URL = `${BASE_API_URL}?vs_currency=${fiatCurrencySymbol}&days=0`;

  axios
    .get(API_URL)
    .then((res) => {
      const zenPrice = parseFloat(res.data.prices[0][1]);
      if (zentofiat) return cb(null, (zenPrice * amount).toFixed(2).toString());
      return cb(null, (amount / zenPrice).toFixed(8).toString());
    })
    .catch((err) => {
      const errMsg = err?.response?.data?.error || err
      debugLog(errMsg)
      return cb(errMsg || err, null);
    });
}

function getsSupportedCurrencies(cb) {
  const API_URL = 'https://api.coingecko.com/api/v3/simple/supported_vs_currencies';

  axios
    .get(API_URL)
    .then((res) => {
      allowedFiatCurrencySymbols = res.data;
      currencyHelp = res.data.sort().toString().replace(/,/g, ' ');
      return cb(null, 'Currency list updated');
    })
    .catch((err) => {
      const errMsg = err?.response?.data?.error || err
      debugLog(errMsg)
      return cb(errMsg || err, null);
    });
}

/**
 * Validate syntax and check if user's balance is enough to manipulate the
 * requested amount and also stop manipulation if amount is 0.
 *
 * @param {User} tipper 
 * @param {Message} message 
 * @param {number} _amount amount of tip
 * @param {function} cb 
 * @return cb returns balance as amount of eZEN 
 */
async function getValidatedAmount(tipper, message, _amount, cb) {
  const bal = await getBalance(tipper);
  // balance is in eZen (ether)
  if (bal.err) {
    message.reply('Error getting your balance');
    return cb(bal.err, null);
  }
  if (_amount === 'all') return cb(null, bal.balance);

  let amount = _amount.trim().toLowerCase();
  debugLog('getValidatedAmount amount: ' + amount);

  let symbol = '';
  if (allowedFiatCurrencySymbols.indexOf(amount.slice(-3)) > -1 || amount.toLowerCase().endsWith('zen')) {
    // Has a correct currency symbol
    symbol = amount.slice(-3);
  } else if (amount.endsWith('zens')) {
    symbol = 'zen';
  } else if (amount === 'random') {
    // random <0.0, 0.1) ZEN
    amount = Math.random() / 10;
  }

  // 8 decimals maximum (no rounding)
  amount = Math.trunc(parseFloat(amount) * 1e8) / 1e8;

  // Not A Number
  if (isNaN(amount)) {
    message.reply('Error incorrect amount');
    return cb('NaN', null);
  }

  // Invalid amount
  if ((!symbol || symbol === 'zen') && amount > MAX_TIP) {
    message.reply(`what? Over maximum of ${MAX_TIP} eZEN!`);
    return cb('Over max', null);
  }

  if (amount <= 0) {
    message.reply('Amount should be >= 0.0000001 eZen');
    return cb('0', null);
  }

  // get fiat to zen value
  if (symbol && symbol !== 'zen') {
    getFiatToZenEquivalent(amount, symbol, false, function (err, value) {
      if (err) {
        message.reply('Error getting fiat rate');
        return cb(err, null);
      }
      if (value > bal.balance) {
        message.reply('Your balance is too low');
        return cb('balance', null);
      }
      return cb(null, value);
    });

    // zen value with no symbol
  } else {
    if (amount > bal.balance) {
      message.reply('Your balance is too low');
      return cb('balance', null);
    }
    return cb(null, amount);
  }
}

/**
 * 
 * @param {User} tipper 
 * @param {Message} message 
 * @param {string} _amount 
 * @param {function} cb 
 * @returns cb with errors or 
 */
async function getValidatedPayoutAmount(tipper, message, _amount, cb) {
  // this version skips getting the balance for the tipper (admin) unless a currency symbol is found

  let amount = _amount.trim().toLowerCase();
  debugLog('getValidatedAmount amount: ' + amount);

  let symbol = '';
  if (allowedFiatCurrencySymbols.indexOf(amount.slice(-3)) > -1 || amount.toLowerCase().endsWith('zen')) {
    // Has a correct currency symbol
    symbol = amount.slice(-3);
  } else if (amount.endsWith('zens')) {
    symbol = 'zen';
  } else if (amount === 'random') {
    // random <0.0, 0.1) ZEN
    amount = Math.random() / 10;
  }

  // 8 decimals maximum
  amount = Math.trunc(parseFloat(amount) * 10e7) / 10e7;

  // Not A Number
  if (isNaN(amount)) {
    message.reply('Error incorrect amount');
    return cb('NaN', null);
  }

  // Invalid amount
  if (amount > 9000) {
    message.reply('what? Over 9000!');
    return cb('Over9K', null);
  }

  if (amount <= 0) {
    message.reply('Amount should be >= 0.0000001 eZen');
    return cb('0', null);
  }

  // get fiat to zen value
  if (symbol && symbol !== 'zen') {
    const bal = await getBalance(tipper);
    if (bal.err) {
      message.reply('Error getting your balance');
      return cb(bal.err, null);
    }
    getFiatToZenEquivalent(amount, symbol, false, function (err, value) {
      if (err) {
        message.reply('Error getting fiat rate');
        return cb(err, null);
      }
      if (value > bal.balance) {
        message.reply('Your balance is too low');
        return cb('balance', null);
      }
      return cb(null, value);
    });

    // zen value with no symbol
  } else {
    return cb(null, amount);
  }
}

/**
 * Validate amount if max is lower than maximum tip amount
 * @param amount
 */
function getValidatedMaxAmount(amount) {
  return amount <= MAX_TIP;
}

function hasPending(userId, blockNum) {
  // check if the block count has incremented.
  const txInfo = pendingTxs[userId];
  if (!txInfo) return false;
  if (txInfo.blockNum >= blockNum - 2) return true;
  delete pendingTxs[userId];
  return false;
}

async function cleanupPending() {
  const entries = Object.entries(pendingTxs);
  if (entries.length > 0) {
    try {
      const blockNum = await botWallet.provider.getBlockNumber();
      if (blockNum) {
        for (const [key, value] of entries) {
          if (blockNum + 1 > value.blockNum) delete pendingTxs[key];
        }
      }
    } catch (error) {
      debugLog('cleanupPending error: ' + error.message);
    }
  }
}


/**
 * Transfer deposited amount to bot's wallet.
 * This uses a set amount of gas and gasprice so entire amount is transferred.
 * 
 * @param {User} user 
 * @param {BigInt} ezenbal balance of user's assigned ezen address
 * @returns logged message if debug
 */
async function transferToBot(user, ezenbal) {
  try {
    const signer = new ethers.Wallet(user.priv, connection);
    const value = ezenbal - TX_COST; // value in wei as a bigInt
    const tx = {
      from: user.address,
      to: botWallet.address,
      gas: GAS_LIMIT,
      gasPrice: GAS_PRICE,
      value,
    }
    const blockNum = await signer.provider.getBlockNumber();
    if (hasPending(user.id, blockNum)) {
      return debugLog(`transfer to bot still pending for ${user.name} in the amount of ${ezenbal}`)
    }

    debugLog(`transferToBot ezenbal= ${ezenbal.toString()}  for user ${user.name || user.id}} `)
    const transaction = await signer.sendTransaction(tx);
    debugLog(transaction)
    const pending = { blockNum, transaction, dt: new Date() }
    pendingTxs[user.id] = pending;

    // updated the net amount deposited.
    const deposited = (toBigInt(user.deposited) + transaction.value).toString();
    const resp = await User.updateOne({ id: user.id }, { deposited })
    if (resp.modifiedCount == 0) {
      return debugLog(`Unable to update user record user.id ${user.id}`);
    }
    return debugLog(`transfer ${Number(value) / 1e18} (${Number(ezenbal) / 1e18} minus fees) for ${user.id}  txid:${transaction.hash}`);
  } catch (error) {
    if (error?.info?.error?.data) debugLog(`${error.info.error.data} for account ${user.address} for member ${user.name || user.id}`)
    if (error) return debugLog(error);
  }
};

/**
 * Check the user's assigned ezen address for deposited funds
 *  and move to the bot address if found
 * 
 * @param {User} user 
 */
function checkFunds(user) {
  debugLog('Checking funds for ' + user.address)
  const url = `addresses/${user.address}/coin-balance-history`
  axiosApi
    .request({ url })
    .then((res) => {
      const bal = toBigInt(res.data.items[0].value)
      if (bal > 2n * TX_COST) {
        transferToBot(user, bal);
      }
    })
    .catch((err) => {
      return debugLog(`Check funds for ${user.address}. ${err?.response?.data?.message || err}`);
    });
}

/**
 * Move all funds to the bot's address.
 *  called periodically from sweepfunds
 */
async function moveFunds() {
  try {
    const allUsers = await User.find({})
    allUsers.forEach((user) => {
      checkFunds(user);
    });
  } catch (err) {
    if (err) return debugLog(err.data ? err.data : err);
  }
}

async function checkBalances(message, tipper, words, bot) {
  if (!tipper.isAdmin) {
    return message.reply('That is an invalid command. Check with !ezentip help');
  }
  if (message.channel.type !== 1) {
    return message.reply('send me this command in a direct message!');
  }
  let doList = false;
  if (words.length > 1 && words[2] === 'list') doList = true;
  try {
    const allUsers = await User.find({})
    let userTotalZen = 0;
    let balList = 'User balances:\n';
    for (const user of allUsers) {
      const balInfo = await getBalance(user)
      userTotalZen += balInfo.balance || 0
      if (doList) {
        // if user is not found, error message is passed to alert admin
        const name = await getName(user.id, bot);
        balList += `${name}: ${balInfo.balance}\n`
      }
    };
    const usersBalBI = toBigInt((userTotalZen * 1e18).toString());
    const botBalWei = await botWallet.provider.getBalance(ezencfg.address);
    // calc as bigInts to get around js float issues
    const diffZ = Number(toBigInt(botBalWei) - usersBalBI) / 1e18;
    const botBalZen = Number(botBalWei) / 1e18;
    let msg = `Total user balance: ${userTotalZen}. Bot balance: ${botBalZen}. `;
    if (diffZ < 0) msg += `Bot needs ${diffZ} ezen to cover all users.`
    message.reply(msg);
    if (doList) message.reply(balList)

  } catch (err) {
    if (err) return debugLog(err.data ? err.data : err);
  }
}

/**
 * @param message
 * @param tipper
 * @param words
 */
function doWithdraw(message, tipper, words) {
  if (message.channel.type !== 1) {
    return message.reply('send me this command in a direct message!');
  }

  //  wrong command syntax
  if (words.length < 4 || !words) {
    return doHelp(message, words);
  }

  const toAddress = words[3];
  if (!ethers.isAddress(toAddress)) return message.reply('Invalid withdrawl address! Only EON(eZEN starting with 0x) type addresses allowed.');

  getValidatedAmount(tipper, message, words[2], async function (err, amount) {
    if (err) return;

    const ezenbal = toBigInt((amount * 1e18).toString());
    try {
      const value = ezenbal - TX_COST; // value in wei as a bigInt
      const tx = {
        from: botWallet.address,
        to: toAddress,
        gas: GAS_LIMIT,
        gasPrice: GAS_PRICE,
        value,
      }
      const blockNum = await botWallet.provider.getBlockNumber();
      if (pendingTxs[toAddress] && hasPending(toAddress, blockNum)) {
        return debugLog(`withdrawl from bot still pending for ${message.author.id} in the amount of ${amount}`)
      }
      const transaction = await botWallet.sendTransaction(tx);
      debugLog(transaction);
      const pending = { blockNum, transaction, dt: new Date() }
      pendingTxs[toAddress] = pending;

      // updated the net amount deposited.
      const spent = (toBigInt((tipper.spent)) + ezenbal).toString();
      const resp = await User.updateOne({ id: tipper.id }, { spent })
      if (resp.modifiedCount == 0) {
        return debugLog(`Unable to update user record tippper.id ${tipper.id} ${tipper.name}`);
      }
      const fee = Number(TX_COST) / 1e18;
      debugLog(`withdrawl ${Number(value) / 1e18} (${amount} - ${fee} fee) for ${tipper.name} ${tipper.id}  txid:${transaction.hash}`);
      return message.reply(`you withdrew **${amount.toString()} ZEN** (-${fee} fee) to **${toAddress}** (${txLink(transaction.hash)})!`);

    } catch (error) {
      if (error) return debugLog(error);
    }
  });
}


/**
 * 
 * @param {Message} message 
 * @param {User} receiver 
 * @param {array} words 
 * @param {bot} bot 
 * @returns 
 */
async function doOpenTip(message, receiver, words, bot) {
  if (message.channel.type === 1) {
    return message.reply("You can't send me this command in a DM");
  }

  // wrong command syntax
  if (words.length < 2 || !words) {
    return doHelp(message, words);
  }

  const idx = tipAllChannels.findIndex(t => t.channel_id === message.channel.id);
  if (idx === null) {
    return message.reply('sorry, no ZEN packet to `open` in this channel!');
  }
  debugLog('open tip idx ' + idx);
  const tipObj = tipAllChannels[idx];
  const tipper = tipObj.tipper;
  debugLog('open tipper.id ' + tipper.id);

  const bal = await getBalance(tipper);
  if (bal.err) {
    debugLog(bal.err);
    return message.reply('error getting balance!');
  }
  const balance = bal.balance;

  let amount;
  if (tipObj.luck) {
    debugLog('open tipObj.n_used ' + tipObj.n_used);
    debugLog('open tipObj.luck_tips ' + tipObj.luck_tips);
    amount = parseFloat(tipObj.luck_tips[tipObj.n_used]).toFixed(8);
  } else {
    debugLog('open tipObj.amount_total: ' + tipObj.amount_total);
    debugLog('open tipObj.quotient ' + tipObj.quotient);
    amount = parseFloat(tipObj.quotient).toFixed(8);
  }
  debugLog('open amount: ' + amount);
  debugLog('open balance: ' + balance);

  if (amount <= 0) {
    return message.reply("I don't know how to tip that many eZEN!");
  }
  if (amount > balance) {
    return message.reply("Not enough eZEN in the tipper's account!");
  }

  // prevent user from opening your own tip
  if (tipper.id === message.author.id) {
    return message.reply("You can't `open` your own tip ...");
  }

  debugLog('open receiver.id ' + receiver.id);

  const claimed = tipObj.used_user.find(user => user.id = message.author.id);
  if (claimed) return message.reply("You can't `open` this for the second time...");
  // need callback
  const sendError = await sendZen(tipper, receiver, amount)
  if (sendError) {
    debugLog(sendError);
    return message.reply(sendError)
  }
  bot.users.cache.get(tipper.id).send(`${receiver.name}<@${message.author.id}> received your tip (${amount.toString()} eZEN)!`);
  message.author.send(`${tipper.name} sent you a **${amount} eZEN** tip!`);

  debugLog(`open message.author: ${receiver.name} ${receiver.id}`);

  tipObj.n_used += 1;
  tipObj.used_user.push({
    id: message.author.id,
    amount: amount,
  });

  debugLog('tipObj.n ' + tipObj.n);
  debugLog('tipObj.n_used ' + tipObj.n_used);

  // if empty, then remove from active list of open tips
  if (tipObj.n === tipObj.n_used) {
    tipAllChannels.splice(idx, 1);

    return message.reply(`that was the last piece! eZEN Packet from ${tipper.name}<@${tipper.id}> is now empty, thank you!`);
  }
  // });
}

/**
 * Try to find if channel has been already used,
 * if so, then replace last open tip in that channel.
 * @param {object} tip  a tip with
      channel_id: string
      tipper: User
      luck: boolean
      amount_total: number,
      quotient: number,
      n: number,
      n_used: 0,
      luck_tips: array of random tip amounts (if luck is true),
      used_user: [],
      creation_date: new Date(),
 * @param {Message} message  discord message
 * @returns 
 */
function isChannelTipAlreadyExist(tip, message) {
  let now = new Date();
  // in minutes
  let allowedTimeBetweenChannelTips = 20;
  let diffMs;
  let diffMins;
  let type = tip.luck ? 'LUCK' : 'EACH';

  for (let i = 0; i < tipAllChannels.length; i++) {
    if (tipAllChannels[i].channel_id === tip.channel_id) {
      // milliseconds between now
      diffMs = now - tipAllChannels[i].creation_date;
      // minutes
      diffMins = Math.round(((diffMs % 86400000) % 3600000) / 60000);

      debugLog('isChannelTipAlreadyExist diffMs: ' + diffMs);
      debugLog('isChannelTipAlreadyExist diffMins: ' + diffMins);

      if (diffMins > allowedTimeBetweenChannelTips) {
        // tip already exist, but it expire -> replace it
        tipAllChannels[i] = tip;
        message.reply('new `' + type + '` eZEN tip package created with total ' + tip.amount_total.toString() + ' eZEN! First ' + tip.n + ' members can claim a portion with command `!ezentip open`');
        return 0;
      } else {
        // tip already exist and is still valid
        message.reply("can't create new eZEN packet because" + ' the previous tip is still in progress!\n**' + tipAllChannels[i].n_used + '/' + tipAllChannels[i].n + ' opened**\n**' + (20 - diffMins) + ' minutes left**');
        return 1;
      }
    }
  }
  // tip doesnt exist in this channel -> create new
  tipAllChannels.push(tip);
  message.reply('new `' + type + '` eZEN tip package created with total ' + tip.amount_total.toString() + ' eZEN! First ' + tip.n + ' members can claim a portion with command `!ezentip open`');
  return 2;
}

/**
 * Shuffle array.
 * @param array
 */
function shuffle(array) {
  let counter = array.length;

  // While there are elements in the array
  while (counter > 0) {
    // Pick a random index
    let index = Math.floor(Math.random() * counter);

    // Decrease counter by 1
    counter--;

    // And swap the last element with it
    let temp = array[counter];
    array[counter] = array[index];
    array[index] = temp;
  }

  return array;
}

/**
 * @param message
 * @param tipper
 * @param words
 */
function createTipLuck(message, tipper, words) {
  if (message.channel.type === 1) {
    return message.reply("You can't send me this command in a DM");
  }

  // wrong command syntax.  if here words[1] = 'each'
  if (words.length < 4) {
    return message.reply("Incomplete command. Check help.  DM me !ezentip help")
  } else if (!words) {
    return doHelp(message, words);
  }

  getValidatedAmount(tipper, message, words[2], function (err, amount) {
    if (err) return;

    if (!getValidatedMaxAmount(amount)) {
      return message.reply('Tip 1 zen maximum !');
    }

    let n = parseFloat(words[3]).toFixed(8);
    if (isNaN(n) || n <= 0) {
      return message.reply("I don't know how to tip that many people!");
    } else if (n > 20) {
      return message.reply('20 people is the maximum per ZEN packet!');
    }
    let quotient = (amount / n).toFixed(8);

    debugLog('createTipLuck amount ' + amount);
    debugLog('createTipLuck n ' + n);
    debugLog('createTipLuck quotient ' + quotient);

    let luckTips = new Array(parseInt(n));
    if (n > 1) {
      for (let i = 0; i < luckTips.length - 1; i++) {
        luckTips[i] = (Math.random() * parseFloat(quotient)).toFixed(8);
      }

      let sum = luckTips.reduce(function (total, num) {
        return parseFloat(total) + parseFloat(num);
      });
      debugLog('createTipLuck sum ' + sum);

      luckTips[luckTips.length - 1] = (parseFloat(amount) - parseFloat(sum)).toFixed(8);
      debugLog('createTipLuck luckTips ' + luckTips);

      // shuffle random tips (somewhere is BONUS) :-)
      luckTips = shuffle(luckTips);
      debugLog('createTipLuck luckTips (shuffled) ' + luckTips);
    } else {
      luckTips[0] = parseFloat(amount).toFixed(8);
    }

    let tipOneChannel = {
      channel_id: message.channel.id,
      tipper: tipper,
      luck: true,
      amount_total: amount,
      quotient: quotient,
      n: parseInt(n),
      n_used: 0,
      luck_tips: luckTips,
      used_user: [],
      creation_date: new Date(),
    };

    isChannelTipAlreadyExist(tipOneChannel, message);
  });
}

/**
 * @param message
 * @param tipper
 * @param words
 */
function createTipEach(message, tipper, words) {
  if (message.channel.type === 1) {
    return message.reply("You can't send me this command in a DM");
  }

  // wrong command syntax.  if here it was routed by word[1] = 'luck'
  if (words.length < 4) {
    return message.reply("Incomplete command. Check help.  DM me !ezentip help")
  } else if (!words) {
    return doHelp(message, words);
  }

  getValidatedAmount(tipper, message, words[2], function (err, amount) {
    if (err) return;

    if (!getValidatedMaxAmount(amount)) {
      return message.reply(`Tip ${MAX_TIP} ezen maximum !`);
    }

    let n = parseFloat(words[3]).toFixed(8);
    if (isNaN(n) || n <= 0) {
      return message.reply("I don't know how to tip that many people!");
    } else if (n > 20) {
      return message.reply('20 people is the maximum per eZEN packet!');
    }
    let quotient = (amount / n).toFixed(8);

    debugLog('createTipEach n ' + n);
    debugLog('createTipEach quotient ' + quotient);
    debugLog('createTipEach amount ' + amount);

    let tipOneChannel = {
      channel_id: message.channel.id,
      tipper: tipper,
      luck: false,
      amount_total: amount,
      quotient: quotient,
      n: parseInt(n),
      n_used: 0,
      used_user: [],
      creation_date: new Date(),
    };

    isChannelTipAlreadyExist(tipOneChannel, message);
  });
}

/**
 * @param usertxt
 */
function resolveMention(usertxt) {
  let userid = usertxt;
  if (usertxt.startsWith('<@!')) {
    userid = usertxt.substr(3, usertxt.length - 4);
  } else {
    if (usertxt.startsWith('<@')) {
      userid = usertxt.substr(2, usertxt.length - 3);
    }
  }
  return userid;
}

function isNumber(value) {
  return !isNaN(parseFloat(value)) && isFinite(value);
}

/**
 * 
 * @param {string} ident  id or username 
 * @param {bot} bot 
 * @returns guild member if found
 */
async function getDiscordUser(identity, bot) {
  let ident = identity.startsWith("@") ? identity.substring(1) : identity;
  let user = bot.users.cache.get(ident);
  if (!user && isNumber(ident)) {
    // try fetching
    const member = await bot.guilds.cache.get(botcfg.serverId).members.fetch(ident);
    user = member.user;
  }
  if (!user) {
    // try by name.  User may not have selected the recipient user and just entered text
    debugLog(`getDiscordUser finding recipient by name ${ident}`);
    user = bot.users.cache.find(u => u.globalName === ident);
    if (!user) {
      // 
      const guild = await bot.guilds.fetch(botcfg.serverId);
      const members = await guild.members.search({ query: ident });

      // ensure search found globalName and not some other value matched
      if (members.size >= 1) {
        for (const value of members) { if (value[1].user.globalName === ident) user = value[1].user }
      }
      if (user) debugLog(`Found user ${ident} id = ${user.id}`)
    }
  }

  return Promise.resolve(user);
}

/**
 * @param message
 * @param tipper
 * @param words
 * @param bot
 */
function doTip(message, tipper, words, bot) {
  if (message.channel.type === 1) {
    return message.reply("You can't send me this command in a DM");
  }

  // wrong command syntax
  if (words.length < 3 || !words) {
    return doHelp(message, words);
  }

  getValidatedAmount(tipper, message, words[2], async function (err, amount) {
    if (err) return;

    if (!getValidatedMaxAmount(amount)) {
      return message.reply(`Tip ${MAX_TIP} ezen maximum !`);
    }

    let targetId = resolveMention(words[1]);
    debugLog('doTip targetId resolved: ' + targetId);
    try {
      const target = await getDiscordUser(targetId, bot);
      debugLog('doTip target recipient: ' + (target ? target.id : 'not found'));

      if (!target) {
        return message.reply("I cant't find a user in your tip ...");
      } else {
        if (tipper.id === target.id) {
          return message.reply("You can't tip yourself ...");
        }
        const { err, user } = await getUser(target.id, bot, false)
        if (err) {
          return message.reply(err.message || err);
        }
        let username = target.globalName || user.name;
        if (!username) {
          const name = await getName(target.id, bot, target);
          // "Unknown Member" if not found in the guild.
          username = name.includes('ERROR') ? name.substring(name.indexOf(':') + 2) : name;
        }

        const sendError = await sendZen(tipper, user, amount)
        if (sendError) {
          debugLog(sendError);
          return message.reply(sendError)
        }
        message.author.send(`${username} received your tip (${amount} eZEN)!`);
        const msgtotarget = words.length > 3 ? words.slice(3).join(' ') : '';
        const text = `${tipper.name} sent you a **${amount} eZEN** tip! ${msgtotarget}`;
        target.send(text);
        // });
        ;
      }
    } catch (error) {
      debugLog('Failed to fetch user or process tip: ', error);
    }
  });
}

function doPayout(message, tipper, words, bot) {
  if (message.channel.type === 1) {
    return message.reply("You can't send me this command in a DM");
  }

  if (!tipper.isAdmin) {
    return message.reply('That is an invalid command. Check !ezentip help');
  }

  // wrong command syntax
  if (words.length < 3 || !words) {
    return doHelp(message, words);
  }

  getValidatedPayoutAmount(tipper, message, words[3], async function (error, amount) {
    if (error) return;

    if (!getValidatedMaxAmount(amount)) {
      return message.reply(`Payout ${MAX_TIP} ezen maximum !`);
    }

    let targetId = resolveMention(words[2]);
    debugLog('doPayout targetId  ' + targetId);

    try {
      const target = await getDiscordUser(targetId, bot);
      debugLog('doPayout target.id ' + target.id);

      if (!target) {
        return message.reply("I cant't find a user in your payout ...");
      } else {
        if (tipper.id === target.id) {
          return message.reply("You can't pay yourself ...");
        }

        const { err, user } = await getUser(target.id, bot, false)
        if (err) {
          return message.reply(err.message || err);
        }
        let username = user.globalName;
        if (!username) {
          const name = await getName(target.id, bot, target);
          // "Unknown Member" if not found in the guild.
          username = name.includes('ERROR') ? name.substring(name.indexOf(':') + 2) : name;
        }


        const sendError = await sendZen(tipper, user, amount)
        if (sendError) {
          debugLog(sendError);
          return message.reply(sendError)
        }
        message.author.send(`${username} received your tip (${amount} eZEN)!`);
        const msgtotarget = words.length > 4 ? words.slice(4).join(' ') : '';
        const text = `${tipper.name} sent you a **${amount} ZEN** tip! ${msgtotarget}`;
        target.send(text);
        if (moderation.logchannel) sendToBotLogChannel(bot, `payout of ${amount} sent to <@${user.id}> ${msgtotarget}`);
        // });

      }
    } catch (error) {
      debugLog('Failed to fetch user or process tip: ', error);
    }
  });
}

async function doMultiPayout(message, tipper, words, bot) {
  if (message.channel.type === 1) {
    return message.reply("You can't send me this command in a DM");
  }

  if (!tipper.isAdmin) {
    return message.reply('That is an invalid command. Check !ezentip help');
  }

  // wrong command syntax
  if (words.length < 3 || !words) {
    return doHelp(message, words);
  }

  const recipients = [];
  let user;
  let unfound = '';
  let idx = 0;
  let tipMessage;
  for (const word of words) {
    if (idx > 2) {
      if (word.startsWith("<@")) {
        const id = resolveMention(word);
        user = await getDiscordUser(id, bot);
        if (!user) {
          unfound += ` ${word}\n`
        } else {
          recipients.push(user);
        }
      } else if (word.startsWith("@")) {
        user = await getDiscordUser(word, bot);
        if (!user) {
          unfound += ` ${word}\n`
        } else {
          recipients.push(user);
        }

      } else {
        break;
      }
    }
    idx = idx + 1;
  }

  if (unfound) return message.reply(`Unable to find the following users\n ${unfound}`);
  if (recipients.length === 0) return message.reply('Unable to find any recipients');

  if (idx < words.length) tipMessage = words.slice(idx).join(" ");
  // debugLog(recipients);

  getValidatedPayoutAmount(tipper, message, words[2], async function (err, amount) {
    if (err) return;

    // command order is '!ezenttip command amount idlist message'
    //  breakdown list of users and validate
    const ids = words[3].replace(":", ",").split(',');
    if (ids.length === 0) return message.reply("No list of user ids found");

    const hasTipper = ids.filter((id) => id === tipper.id)
    if (hasTipper.length > 0) {
      return message.reply(`You can't pay yourself. Please remove id ${hasTipper[0]}`);
    }

    // check tipper balance
    const total = words[2] * ids.length;
    const balInfo = await getBalance(tipper, bot);
    if (total > balInfo.balance) return message.reply(`Insufficient funds. ${(balInfo.balance - total).toFixed(8)} needed.`)


    // payout to each
    try {

      for (const member of recipients) {

        const { err, user } = await getUser(member.id, bot, false)
        if (err) {
          return message.reply(err.message || err);
        }
        let username = member.globalName || user.name;
        if (!username) {
          const name = await getName(member.id, bot);
          username = name.includes('ERROR') ? name.substring(name.indexOf(':') + 2) : name;
        }

        const sendError = await sendZen(tipper, user, amount, bot)
        if (sendError) {
          debugLog(sendError);
          return message.reply(sendError)
        }
        message.author.send(`${username} received your tip (${amount} eZEN)!`);
        // const msgtotarget = words.length > 4 ? words.slice(4).join(' ') : '';
        const text = `${tipper.name} sent you a **${amount} ZEN** tip! ${tipMessage || ''}`;
        member.send(text).catch((error) => {
          message.author.send(`Unable to send message to ${username}. DM may be blocked. ${error.message}.`);
        })
        if (moderation.logchannel) sendToBotLogChannel(bot, `payout of ${amount} sent to <@${user.id}> ${tipMessage || ''}`);
      }

    } catch (error) {
      debugLog('Failed to fetch user or process tip: ', error);
    }
  });
}


/**
 * 
 * @param {User} tipper 
 * @param {User} receiver 
 * @param {int} amount  ezen to tip
 * @param {bot} bot  optional 
 * @returns Promise with error message if present
 */
// async function sendZen(tipper, receiver, amount, cb) {
async function sendZen(tipperUser, receiver, amount, bot) {
  let user;
  // if bot is passed it means this is in a loop and the tipper balance
  // must be retrieved from the database each time since it is being updated
  // multiple times.
  if (bot) ({ user } = await getUser(tipperUser.id, bot, true));
  const tipper = user || tipperUser;
  const wei = toBigInt((amount * 1e18).toString())
  // update tipper's spent amount
  const sent = (toBigInt(tipper.spent) + wei).toString()
  let resp = await User.updateOne({ id: tipper.id }, { spent: sent }).exec();
  if (resp.modifiedCount != 1) {
    const msg = `Sending failed. Unable to update sent amount for ${tipper.name}`
    // return cb("error", msg)
    return Promise.resolve(msg)
  }
  debugLog(`SendZen: added ${amount} to spent for user ${tipper.id}`);

  // and receiver's received amount
  const rcvd = (toBigInt(receiver.received) + toBigInt(wei)).toString()
  resp = await User.updateOne({ id: receiver.id }, { received: rcvd }).exec();
  if (resp.modifiedCount != 1) {
    const msg = `Sending failed. Unable to update received amount for ${receiver.name}`
    // revert the tipper Update.
    resp = await User.updateOne({ id: tipper.id }, { spent: tipper.spent }).exec();
    return Promise.resolve(msg)
  }
  debugLog(`SendZen: added ${amount} to received for user ${receiver.id}`);
  return Promise.resolve('')
}

/**
 * @param txId is transaction id
 */
function txLink(txId) {
  return `<${EON_EXPLORER}tx/${txId}> `;
}

/**
 * @param log - log if bot is in debug mode
 */
function debugLog(log) {
  if (botcfg.debug) {
    let ts = '';
    if (includetimestamp) {
      const dt = (new Date()).toISOString().slice(0, 19).replace("T", " ");
      ts = `${dt}--`;
    }
    console.log(`${ts}${log}`);
  }
}

function sendToBotLogChannel(bot, msgtext) {
  try {
    const channel = bot.channels.cache.get(moderation.logchannel);
    channel.send(msgtext);
  } catch (error) {
    return debugLog(error.data ? error.data : error);
  }
}

function suspend(msg, tipper, words, bot) {
  if (!tipper.isAdmin) {
    return msg.reply('That is an invalid command. Check with !ezentip help');
  }
  lastSuspend = new Date();

  if (words[2]) {
    if (!regSuspend.test(words[2])) return msg.reply('Minutes must be between 1 and 100. Suspend failed.');
    sweepSuspend = Number(words[2]) * 60 * 1000;
  }
  if (moderation.logchannel) sendToBotLogChannel(bot, `Scheduled background task suspended for ${sweepSuspend / 1000 / 60} minutes.`);

  return msg.reply(`Scheduled background task suspended for ${sweepSuspend / 1000 / 60} minutes.`);
}

function sweepFunds() {
  if (lastSuspend.getTime() + sweepSuspend - 500 > 0) {
    debugLog('sweeping funds');
    moveFunds();
    cleanupPending();
  }
  setTimeout(sweepFunds, sweepInterval);
}

getsSupportedCurrencies((err, resp) => {
  if (err) return debugLog(`getSupportedCurrencies: ${err} `);
  debugLog(resp);
});
initMongo().then(() =>
  sweepFunds()
)
