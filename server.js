const express = require("express");
const app = express();

const path = require("path");
const bodyParser = require("body-parser");
const mongoose = require("mongoose");

require("dotenv").config({
    path: path.resolve(__dirname, "credentialsDontPost/.env"),
});

const uri = process.env.MONGO_CONNECTION_STRING;
const MARKETSTACK_KEY = process.env.MARKETSTACK_ACCESS_KEY;

app.use(bodyParser.urlencoded({ extended: false }));
app.set("view engine", "ejs");
app.set("views", path.resolve(__dirname, "templates"));
app.use(express.static(path.resolve(__dirname, "public")));

// mongoose 
const HoldingSchema = new mongoose.Schema(
    {
        ticker: { type: String, required: true, trim: true, uppercase: true },
        quantity: { type: Number, required: true, min: 0 },
        avgPurchasePrice: { type: Number, required: true, min: 0 },
        lastPrice: { type: Number, default: 0, min: 0 },
    },
    { _id: false }
);

const PortfolioSchema = new mongoose.Schema({
    cash: { type: Number, required: true, min: 0 },
    holdings: { type: [HoldingSchema], default: [] },
});

const Portfolio = mongoose.model("Portfolio", PortfolioSchema);

// helpers 
async function ensurePortfolio() {
    let p = await Portfolio.findOne({});
    if (!p) {
        p = new Portfolio({ cash: 100000, holdings: [] });
        await p.save();
    }
    return p;
}

// API fundtions 
function marketstackEodLatest(symbolsArray) {
    const symbols = symbolsArray.join(",");

    const url = new URL("https://api.marketstack.com/v2/eod/latest");
    url.search = new URLSearchParams({
        access_key: MARKETSTACK_KEY,
        symbols: symbols,
    }).toString();

    return fetch(url)
        .then((resp) => {
            if (!resp.ok) {
                return { data: [], error: `Marketstack HTTP error` };
            }
            return resp.json().then((json) => {
                const rows = json.data;
                return { data: rows, error: "" };
            });
        })
        .catch(() => {
            return { data: [], error: "Marketstack API error." };
        });
}

function getLatestClose(ticker) {
    return marketstackEodLatest([ticker]).then(({ data }) => {
        const row = data[0];
        if (!row || typeof row.close !== "number") return null;
        return row.close;
    });
}

// ROUTERS ---------------------
const mainRouter = express.Router();
const tradeRouter = express.Router();
const marketRouter = express.Router();

// home
mainRouter.get("/", (req, res) => {
  res.render("index");
});

// dashboard
mainRouter.get("/dashboard", async (req, res) => {
    try {
        const portfolio = await ensurePortfolio();
        const holdings = portfolio.holdings;
        let apiError = "";

        // refresh holdings using last eod price
        if (holdings.length > 0) {
            //gather all close prices from api
            const tickers = holdings.map(h => h.ticker);
            const { data, error } = await marketstackEodLatest(tickers);
            apiError = error;

            const priceMap = new Map(data.map(r => [r.symbol, r.close]));
            let changed = false;

            // for each stock help, find the close price
            for (const stock of holdings) {
                const price = priceMap.get(stock.ticker);
                if (typeof price === "number") {
                    stock.lastPrice = price;
                    changed = true;
                }
            }

            if (changed) {
                await portfolio.save();
            }
        }

        // for each stock, make a row in the table with its elements
        const rows = holdings.map(h => {
            const last = Number(h.lastPrice || 0);
            const value = last * h.quantity;
            const pnl = (last - h.avgPurchasePrice) * h.quantity;
            return {
                ticker: h.ticker,
                quantity: h.quantity,
                avgPurchasePrice: h.avgPurchasePrice,
                lastPrice: last,
                marketValue: value,
                pnl,
            };
        });

        //add up value of each holding
        const totalMarketValue = rows.reduce((sum, row) => sum + row.marketValue, 0);
        const totalEquity = portfolio.cash + totalMarketValue;

        res.render("dashboard", {
            timeCompleted: new Date().toString(),
            cash: portfolio.cash,
            totalMarketValue,
            totalEquity,
            holdings: rows,
            apiError,
        });
    } catch (e) {
        console.error(e);
        res.status(500).send("Error loading dashboard");
    }
});

// trade get
tradeRouter.get("/", async (req, res) => {
    const portfolio = await ensurePortfolio();
    res.render("trade", {
        cash: portfolio.cash,
        holdings: portfolio.holdings,
        message: "",
    });
});

// trade post
tradeRouter.post("/processTrade", async (req, res) => {
    const action = String(req.body.action).toLowerCase(); // buy or sell
    const ticker = String(req.body.ticker).trim().toUpperCase();
    const qty = Number(req.body.quantity);

    try {
        const portfolio = await ensurePortfolio();

        if (!ticker) throw new Error("Ticker cannot be empty.");
        if (!Number.isFinite(qty) || qty <= 0) throw new Error("Quantity must be a positive integer.");

        const price = await getLatestClose(ticker);
        const cost = price * qty;

        // get mondo index and if ticker is already owned store it
        const idx = portfolio.holdings.findIndex(h => h.ticker === ticker);
        const existing = idx >= 0 ? portfolio.holdings[idx] : null;

        if (action === "buy") {
        if (portfolio.cash < cost) throw new Error("Not enough cash for this buy.");

        if (!existing) { //if user doesn't already own
            portfolio.holdings.push({
            ticker,
            quantity: qty,
            avgPurchasePrice: price,
            lastPrice: price,
            });
        } else { //if user already owns
            const newQty = existing.quantity + qty;
            const newAvg = ((existing.avgPurchasePrice * existing.quantity) + (price * qty)) / newQty;

            existing.quantity = newQty;
            existing.avgPurchasePrice = newAvg;
            existing.lastPrice = price;
        }

        portfolio.cash -= cost;

        } else { // SELL
            if (!existing || existing.quantity < qty) throw new Error("Not enough shares to sell.");

            existing.quantity -= qty;
            existing.lastPrice = price;
            portfolio.cash += cost;

            //if total number is decreased to zero, remove from db
            if (existing.quantity === 0) {
                portfolio.holdings.splice(idx, 1);
            }
        }

        await portfolio.save();

        res.render("trade", {
            cash: portfolio.cash,
            holdings: portfolio.holdings,
            message: `${action.toUpperCase()} ${qty} ${ticker} @ $${price.toFixed(2)} complete.`,
        });
    } 
    catch (e) {
        const portfolio = await ensurePortfolio();
        res.render("trade", {
            cash: portfolio.cash,
            holdings: portfolio.holdings,
            message: `ERROR: ${e.message}`,
        });
    }
});

const MARKET_TICKERS = ["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA", "JPM", "V", "UNH"];

marketRouter.get("/", async (req, res) => {
    try {
        const { data, error } = await marketstackEodLatest(MARKET_TICKERS);

        // create rows for market table
        const rows = data
            .filter(r => typeof r.open === "number" && r.open !== 0 && typeof r.close === "number")
            .map(r => ({
                ticker: r.symbol,
                open: r.open,
                close: r.close,
                pct: ((r.close - r.open) / r.open) * 100,
                date: r.date,
        }));

        res.render("market", {
            timeCompleted: new Date().toString(),
            apiError: error,
            tickers: MARKET_TICKERS,
            rows,
        });
    } catch (e) {
        console.error(e);
        res.status(500).send("Error loading market page");
    }
});

//mount routers
app.use("/", mainRouter);
app.use("/trade", tradeRouter);
app.use("/market", marketRouter);


async function start() {
    try {
        await mongoose.connect(uri);
        await ensurePortfolio();

        const server = app.listen(4040, () => {
            console.log(`Web server started and running at http://localhost:${4040}`);
            process.stdout.write("Type stop to shutdown the server: ");
        });

        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk) => {
        const cmd = String(chunk).trim();
        if (cmd === "stop") {
            console.log("Shutting down the server");
            server.close(async () => {
                try {
                    await mongoose.disconnect();
                } catch (e) {
                    console.error("Error disconnecting mongoose:", e);
                } finally {
                    process.exit(0);
                }
            });
        } else {
            console.log(`Invalid command: ${cmd}`);
            process.stdout.write("Type stop to shutdown the server: ");
        }
        });
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}

start();