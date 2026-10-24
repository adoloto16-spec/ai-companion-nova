import React from "react";
import { createRoot } from "react-dom/client";
import AvatarOverlay from "./avatar-overlay";
import "./avatar.css";

document.documentElement.classList.add("avatar-transparent-document");
document.body.classList.add("avatar-transparent-document");
createRoot(document.getElementById("root")!).render(<React.StrictMode><AvatarOverlay/></React.StrictMode>);
