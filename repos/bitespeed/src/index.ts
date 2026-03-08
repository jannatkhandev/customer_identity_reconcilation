import express from "express";
import identifyRouter from "./routes/identify";

const app = express();

app.use(express.json());
app.use("/identify", identifyRouter);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
