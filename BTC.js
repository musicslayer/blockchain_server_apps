const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const url = require('url');
const PORT = 80;

// Favicon file
const FAVICON_FILE = 'favicon.ico';

// Use 0 to save bandwidth, but use a larger number to make responses easier to read.
const FORMAT_JSONINDENT = 0;

// Timeout of 5 minutes for any request should be more than enough.
const REQUEST_TIMEOUT = 300000; //milliseconds

// Limit the log file size to 1GB.
const LOG_FILE = 'log.txt';
const LOG_SIZELIMIT = 1 * 1024 * 1024 * 1024; //bytes
const LOG_MARKER = [];

// Rate limit is 100 requests every minute per IP Address.
const RATELIMIT_RECORDS = new Map();
const RATELIMIT_COUNT_LOW = 3;
const RATELIMIT_COUNT_HIGH = 10;
const RATELIMIT_COUNT_MAX = 1000000;
const RATELIMIT_RESETTIME = 60000; //milliseconds

// Use this to limit the number of processes we spawn simultaneously.
const SPAWNQUEUE = []; // Tasks to do (this has no size limit).
const SPAWNQUEUE_LIMIT = 50; // Max number of simultaneously running tasks.
const SPAWNQUEUE_CURRENTMARKERS = []; // Markers for currently running tasks.

const server = http.createServer((req, res) => {
	logProgress("!!! START !!!");
	res.isEnded = false;
	res.statusCode = 200;

	try {
		// Only allow GET method.
		if(req.method !== "GET") {
			res.setHeader('Content-Type', 'text/plain');
			writeError(res, `"Invalid method (${req.method})."`);
			return;
		}

		// Special case for favicon.
		if(req.url === "/favicon.ico") {
			res.setHeader('Content-Type', 'image/x-icon');
			fs.createReadStream(FAVICON_FILE).pipe(res);
			return;
		}

		res.setHeader('Content-Type', 'text/plain');

		if(!isValidString(req.url)) {
			logDebugError(req, new Error("URL String Not Valid."));
			writeError(res, '"URL string not valid."');
			return;
		}

		const queryObject = url.parse(req.url, true).query;

		if(!isValidQuery(queryObject)) {
			logDebugError(req, new Error("URL Query Not Valid."));
			writeError(res, '"URL query not valid."');
			return;
		}

		// Apply rate limiter before making blockchain queries.
		logProgress("!!! CHECK_RATE !!!");
		if(isRateLimited(req, queryObject.apikey)) {
			var RATELIMIT_ERRORMESSAGE;
			if(queryObject.apikey === "qwerty") {
				RATELIMIT_ERRORMESSAGE = `${RATELIMIT_COUNT_HIGH} queries per minute per IP address`;
			}
			else {
				RATELIMIT_ERRORMESSAGE = `${RATELIMIT_COUNT_LOW} queries per minute per IP address`;
			}

			writeError(res, `"Rate limit reached (${RATELIMIT_ERRORMESSAGE})."`);
			logProgress("!!! CHECK_RATE_FAIL !!!");
			return;
		}
		logProgress("!!! CHECK_RATE_PASS !!!");

		// Process data based on "info" option. Exact case-sensitive match required.
		if(queryObject.info === 'balance') {
			getBalanceInfo(queryObject.address, req, res);
		}
		else if(queryObject.info === 'transaction') {
			getTransactionInfo(queryObject.address, req, res);
		}
		else {
			logDebugError(req, new Error("Unknown Info Option: " + queryObject.info));
			writeError(res, `"Unknown info option (${queryObject.info})."`);
		}
	}
	catch(error) {
		logError(req, error);
		writeError(res, '"Error processing request."');
	}
});

server.timeout = REQUEST_TIMEOUT;

server.listen(PORT, () => {
	console.log(`server running on port ${PORT}.`);
});

setInterval(() => {
	// Reset the rate limit data every interval.
	RATELIMIT_RECORDS.clear();
}, RATELIMIT_RESETTIME);

function isRateLimited(req, apikey) {
	var RATELIMIT_COUNT;
	if(apikey === "qwerty") {
		RATELIMIT_COUNT = RATELIMIT_COUNT_HIGH;
	}
	else {
		RATELIMIT_COUNT = RATELIMIT_COUNT_LOW;
	}

	var ip = req.socket.remoteAddress;
	var record = RATELIMIT_RECORDS.get(ip);
	if(record) {
		// Record exists (within time window).
		// Limit this value to prevent overflow.
		record.count = Math.min(record.count + 1, RATELIMIT_COUNT_MAX + 1);
	}
	else {
		// First time (within time window).
		record = new Object;
		record.count = 1;
		RATELIMIT_RECORDS.set(ip, record);
	}

	return record.count > RATELIMIT_COUNT;
}

function logError(req, error, info) {
	// Log all errors to the log file.
	var MARKER = "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!";
	var timestamp = new Date().toISOString();
	var ip = req.socket.remoteAddress;
	if(!info) {
		info = "(No Info)";
	}

	errorStr = MARKER + "\n" + 
		"Timestamp: " + timestamp + "\n" +
		"IP: " + ip + "\n" +
		"URL: " + req.url + "\n" + 
		"INFO: " + info + "\n" + 
		"ERROR: " + error + "\n" +
		"ERROR STACK: " + error.stack + "\n\n";

	writeToLogFile(errorStr);
}

function writeToLogFile(str) {
	// Write to log file, but if we error or the size would be too big then just print once to console.
	if(LOG_MARKER.length > 0) { return; }

	try {
		// Create log file if it doesn't exist.
		if(!fs.existsSync(LOG_FILE)) {
			fs.writeFileSync(LOG_FILE, "");
		}
		var stats = fs.statSync(LOG_FILE);

		var currentSize = stats.size;
		var newSize = Buffer.byteLength(str, 'utf8');
		var totalSize = currentSize + newSize;
	
		if(totalSize > LOG_SIZELIMIT) {
			LOG_MARKER.push(true);
			console.log("LOG FILE LIMIT REACHED");
			console.log("Last Log String: " + str);
		}
		else {
			fs.appendFileSync(LOG_FILE, str);
		}
	}
	catch(error) {
		LOG_MARKER.push(true);
		console.log("LOG FILE ERROR");
		console.log(error);
		console.log("Last Log String: " + str);
	}
}

function createResponse(isSuccess, errorMessage, data) {
	var responseStr = `{"isSuccess":${isSuccess},"errorMessage":${errorMessage},"data":${data}}`;
	var jsonStr = JSON.stringify(JSON.parse(responseStr), null, FORMAT_JSONINDENT);
	return jsonStr;
}

function writeError(res, str) {
	if(!res.isEnded) {
		res.isEnded = true;
		res.write(createResponse(false, str, "null"));
		res.end();
	}
}

function writeSuccess(res, str) {
	if(!res.isEnded) {
		res.isEnded = true;
		res.write(createResponse(true, "null", str));
		res.end();
	}
}

function isValidString(str) {
	// The query must be an alphanumeric string with a certain length range.
	if(typeof(str) !== 'string') {
		return false;
	}
	if(str.length < 5 || str.length > 400) {
		return false;
	}
	if(str.charCodeAt(0) !== 47) {
		return false;
	}
	for(var i = 1; i < str.length; i++) {
		if(!((str.charCodeAt(i) >= 48 && str.charCodeAt(i) <= 57) || (str.charCodeAt(i) >= 65 && str.charCodeAt(i) <= 90) || (str.charCodeAt(i) >= 97 && str.charCodeAt(i) <= 122) || str.charCodeAt(i) === 38 || str.charCodeAt(i) === 61 || str.charCodeAt(i) === 63)) {
			return false;
		}
	}
	return true;
}

function isValidQuery(queryObject) {
	// Check for expected and optional query keys (order does not matter, but case and count do).
	const requiredKeys = ["info", "address"];
	const optionalKeys = ["apikey"];

	const queryObjectCopy = Object.assign({}, queryObject);

	for(var rk = 0; rk < requiredKeys.length; rk++) {
		requiredKey = requiredKeys[rk];

		// Each required option must appear exactly one time.
		if(typeof(queryObjectCopy[requiredKey]) !== 'string') {
			return false;
		}

		delete(queryObjectCopy[requiredKey]);
	}

	for(var ok = 0; ok < optionalKeys.length; ok++) {
		optionalKey = optionalKeys[ok];

		// Each optional option must be absent or appear one time.
		if(typeof(queryObjectCopy[optionalKey]) !== 'undefined' && typeof(queryObjectCopy[optionalKey]) !== 'string') {
			return false;
		}

		delete(queryObjectCopy[optionalKey]);
	}

	// If any extra options are there, the query is invalid.
	if(Object.keys(queryObjectCopy).length > 0) {
		return false;
	}

	return true;
}

function getBalanceInfo(address, req, res) {
	logProgress("0 - getBalanceInfo");
	const totalDataArray = [];

	createSpawnCommand("electrum", ["getaddressbalance", address], req, res, 
	data => {
		logProgress("1 - ADD");
		totalDataArray.push(data.toString());
	}, 
	code => {
		logProgress("1 - CLOSE");
		var totalData = '';
		for(var a = 0; a < totalDataArray.length; a++) {
			totalData += totalDataArray[a];
		}

		writeSuccess(res, totalData);
	}, 
	error => {
	});
}

function getTransactionInfo(address, req, res) {
	isError = false;

	logProgress("0 - getTransactionInfo");
	const totalDataArray1 = [];

	createSpawnCommand("electrum", ["getaddresshistory", address], req, res,
	data => {
		logProgress("1 - ADD");
		totalDataArray1.push(data.toString());
	},
	code => {
		logProgress("1 - CLOSE");
		var totalData1 = '';
		for(var a = 0; a < totalDataArray1.length; a++) {
			totalData1 += totalDataArray1[a];
		}

		var jsonArray = JSON.parse(totalData1);

		var responses = [];
		var completed_requests = 0;

		// Early return for no transactions.
		if(jsonArray.length === 0) {
			writeSuccess(res, array2JSON(responses));
			return;
		}

		for(var i = 0; i < jsonArray.length; i++) {
			if(isError) { break; }

			logProgress("TX - " + i);

			var hashJSONObject = jsonArray[i];
			const hash = hashJSONObject.tx_hash;

			const totalDataArray2 = [];

			createSpawnCommand("bitcoin-cli", ["-datadir=/mnt/bitcoin", "getrawtransaction", hash, "true"], req, res,
			data => {
				totalDataArray2.push(data.toString());
			},
			code => {
				logProgress("2 - CLOSE");

				var totalData2 = '';
				for(var a = 0; a < totalDataArray2.length; a++) {
					totalData2 += totalDataArray2[a];
				}

				var transaction2 = JSON.parse(totalData2);
				var inputs = transaction2.vin;

				var inputsresponses = [];
				var completed_inputsresponses = 0;

				// Early return for no inputs.
				if(inputs.length === 0) {
					logProgress("4 - ADD");
					transaction2.vin = inputsresponses;
					transaction2 = filter(transaction2, address);

					responses.push(JSON.stringify(transaction2));
					completed_requests++;

					if(completed_requests === jsonArray.length) {
						logProgress("4 - CLOSE");
						writeSuccess(res, array2JSON(responses));
					}
					return;
				}

				for(var j = 0; j < inputs.length; j++) {
					if(isError) { break; }

					var input = inputs[j];
					const inputIndex = input.vout;
					const inputHash = input.txid;

					const totalDataArray3 = [];

					createSpawnCommand("bitcoin-cli", ["-datadir=/mnt/bitcoin", "getrawtransaction", inputHash, "true"], req, res,
					data => {
						logProgress("3 - ADD");
						totalDataArray3.push(data.toString());
					},
					code => {
						logProgress("3 - CLOSE");
						var totalData3 = '';
						for(var a = 0; a < totalDataArray3.length; a++) {
							totalData3 += totalDataArray3[a];
						}

						var outputs = JSON.parse(totalData3).vout;

						inputsresponses.push(outputs[inputIndex]);
						completed_inputsresponses++;

						if(completed_inputsresponses === inputs.length) {
							logProgress("4 - ADD");
							transaction2.vin = inputsresponses;
							transaction2 = filter(transaction2, address);

							responses.push(JSON.stringify(transaction2));
							completed_requests++;

							if(completed_requests === jsonArray.length) {
								logProgress("4 - CLOSE");
								writeSuccess(res, array2JSON(responses));
							}
						}
					},
					error => {
						isError = true;
					});
				}
			},
			error => {
				isError = true;
			});
		}
	},
	error => {
		isError = true;
	});
}

function filter(transaction, address) {
	// To cut down on data transmitted, omit anything we don't need.
	var newTransaction = Object.create(null);

	var inputs = transaction.vin;
	var newInputs = [];
	for(var i = 0; i < inputs.length; i++) {
		var input = inputs[i];
		if(input.scriptPubKey.addresses !== undefined && input.scriptPubKey.addresses[0] === address) {
			// Only keep value.
			var newInput = Object.create(null);
			newInput.value = input.value;
			newInputs.push(newInput);
		}
	}

	newTransaction.vin = newInputs;

	var outputs = transaction.vout;
	var newOutputs = [];
	for(var i = 0; i < outputs.length; i++) {
		var output = outputs[i];
		if(output.scriptPubKey.addresses !== undefined && output.scriptPubKey.addresses[0] === address) {
			// Only keep value.
			var newOutput = Object.create(null);
			newOutput.value = output.value;
			newOutputs.push(newOutput);
		}
	}

	newTransaction.vout = newOutputs;

	// Only add in fields that we may need.
	newTransaction.txid = transaction.txid;
	newTransaction.confirmations = transaction.confirmations;
	newTransaction.blocktime = transaction.blocktime;

	return newTransaction;
}

function array2JSON(array) {
	// Convert a Javascript array of JSON object strings to a JSON array.
	var s = "[";

	for(var i = 0; i < array.length; i++) {
		s = s + array[i];
		if(i < array.length - 1) {
			s = s + ",";
		}
	}

	s = s + "]";
	return s;
}

function createSpawnCommand(commandStr, args, req, res, dataFunc, closeFunc, errorFunc) {
	// Call "spawn", but intercept errors to log them.

	// We only want to process the first thing that goes wrong.
	var isError = false;

	var commandErrStr = "COMMAND: " + commandStr;
	for(var a = 0; a < args.length; a++) {
		commandErrStr += "\n    ARG" + a + ": " + args[a];
	}

	queueSpawnCommand(() => {
		const command = spawn(commandStr, args);
		command.stdin.end();
		command.stderr.on("data", data => {
			if(isError) { return; }

			try {
				isError = true;
				writeError(res, '"Error processing request."');

				error = new Error(data.toString());
				logError(req, error, commandErrStr);

				errorFunc(error);
			}
			catch(error2) {
				logError(req, error2, commandErrStr);
			}
		});
		command.stdout.on("data", data => {
			if(isError) { return; }

			try {
				dataFunc(data);
			}
			catch(error) {
				try {
					isError = true;
					writeError(res, '"Error processing request."');

					logError(req, error, commandErrStr);

					errorFunc(error);
				}
				catch(error2) {
					logError(req, error2, commandErrStr);
				}
			}
		});
		command.on("error", error => {
			if(isError) { return; }

			try {
				isError = true;
				writeError(res, '"Error processing request."');

				logError(req, error, commandErrStr);

				errorFunc(error);
			}
			catch(error2) {
				logError(req, error2, commandErrStr);
			}
		});
		command.on("close", code => {
			if(isError) { return; }

			try {
				closeFunc(code);
			}
			catch(error) {
				try {
					isError = true;
					writeError(res, '"Error processing request."');

					logError(req, error, commandErrStr);

					errorFunc(error);
				}
				catch(error2) {
					logError(req, error2, commandErrStr);
				}
			}
		});
		command.on("exit", code => {
			SPAWNQUEUE_CURRENTMARKERS.shift();
			checkSpawnCommand();
		});
	});
}

function queueSpawnCommand(spawnFunc) {
	SPAWNQUEUE.push(spawnFunc);
	checkSpawnCommand()
}

function checkSpawnCommand() {
	// This should be called anytime we want to check if we can execute any tasks on the queue.
	if(SPAWNQUEUE.length > 0 && SPAWNQUEUE_CURRENTMARKERS.length < SPAWNQUEUE_LIMIT) {
		var task = SPAWNQUEUE.shift();
		SPAWNQUEUE_CURRENTMARKERS.push(true);
		task();
	}
}

// These are useful for debugging, but not always good for production.
function logProgress(str) {
	//console.log("PROGRESS: " + str);
}

function logDebugError(req, error, info) {
	// Can comment out for production.
	//logError(req, error, info);
}