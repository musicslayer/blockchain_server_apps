# blockchain_server_apps
Apps used by clients to query blockchain data.

Note: The server must also be running both bitcoin-cli and electrum, or else this functionality will not work.

## Example Usage
On a web browser running on the same computer that BTC.js is running:

Balance of an address:

http://localhost/?info=balance&address=bc1q7c5yhtc3leegkyywfrscp5ws33tdv3wxnwmsd7

Transaction history of an address:

http://localhost/?info=transaction&address=bc1q7c5yhtc3leegkyywfrscp5ws33tdv3wxnwmsd7