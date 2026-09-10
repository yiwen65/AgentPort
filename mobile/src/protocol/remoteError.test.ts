import { expect, it } from "vitest";
import { remoteErrorMessage } from "./remoteError";
it.each([new Error("Connection closed"), { code: "connection_closed", message: "Connection closed" }, "Connection closed"])("extracts a readable native error", error => {
  expect(remoteErrorMessage(error)).toBe("Connection closed");
});
it.each([{}, { message: {} }, null, undefined, "", "[object Object]"])("does not stringify opaque errors", error => {
  expect(remoteErrorMessage(error)).toBe("Request failed. Please try again.");
});
