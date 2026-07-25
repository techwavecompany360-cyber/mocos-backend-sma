const { MongoClient } = require("mongodb");
const config = require("../config");

const uri = config.MONGODB_URI;
const dbName = config.DB_NAME;
let db;

async function connectDB() {
  if (db) return db;
  const client = await MongoClient.connect(uri);
  db = client.db(dbName);
  return db;
}

module.exports = connectDB;
