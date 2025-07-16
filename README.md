Features:
✅ Auto Swap and Add Liquidity (LP) on Faroswap (Zenith removed).

✅ Auto Check-in.

Important Modifications:
❗️ Update Referral Code: In checkin.js, change the referral code to: ejvfRPamMvwbHcqx.

❗️ Adjust Swap and Add LP Counts: In swap.js, modify the number of swaps on line 63 and the number of "add LP" actions on line 704.

Setup Guide:
REQUIREMENT: Make sure you have Node.js installed on your system.

Install Dependencies:
Run the following command in your terminal to install all necessary modules:

Bash

npm install
Create wallet.txt:
Create a file named wallet.txt and paste your wallet's private keys into it. Each private key should be on a new line.

Create proxy.txt:
Create a file named proxy.txt and paste your proxies into it. Use the following format for each proxy:
http://user:pass@ip:port

Generate Random User Agent:
Run the following command to generate a random user agent:

Bash

node taoagent.js
Run the Tool:
Finally, start the tool using either of these commands:

Bash

npm start
OR

Bash

node main.js

GOOK LUCK EVERYONE 
