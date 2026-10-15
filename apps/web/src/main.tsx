import { hydrate, render } from "solid-js/web";
import App from "./App";
import "./styles.css";

const root = document.getElementById("root")!;
if (root.hasChildNodes()) hydrate(() => <App />, root);
else render(() => <App />, root);
