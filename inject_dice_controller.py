"""
Script to inject dice-controller into Google App via Frida.

Dependencies:
pip install frida-tools

Usage:
python inject_dice_controller.py
"""

import frida
import sys
import os
import json

# Configuration
TARGET_PACKAGE = "com.google.android.googlequicksearchbox"
EXTENSION_DIR = r"C:\Users\hanzp\.gemini\antigravity-ide\scratch\dice-dashboard\extension"
FILE1 = "dice-controller.user.js"
FILE2 = "content.js"

def get_file_size_kb(filepath):
    return os.path.getsize(filepath) / 1024.0

def read_file(filepath):
    with open(filepath, 'r', encoding='utf-8') as f:
        return f.read()

def main():
    print(f"[*] Preparing to inject script into {TARGET_PACKAGE}")
    
    file1_path = os.path.join(EXTENSION_DIR, FILE1)
    
    try:
        # Read file
        if not os.path.exists(file1_path):
            raise FileNotFoundError(f"File not found: {file1_path}")
            
        size1 = get_file_size_kb(file1_path)
        print(f"[*] Membaca {FILE1} ({size1:.2f} KB)")
        content1 = read_file(file1_path)
        
        combined_script = content1
        total_size = len(combined_script.encode('utf-8')) / 1024.0
        
        print(f"[*] Total script: {total_size:.2f} KB")
        
    except Exception as e:
        print(f"[!] Error reading files: {e}")
        sys.exit(1)

    # Frida injection script for Android WebView/Chrome Custom Tab
    frida_script_code = """
    Java.perform(function() {
        console.log("[*] Frida script loaded inside target process.");
        
        var scriptToInject = %s;
        
        // Helper function to inject into a webview instance
        function injectIntoWebView(webViewInstance) {
            console.log("[*] Found WebView instance, attempting to evaluate Javascript...");
            Java.scheduleOnMainThread(function() {
                try {
                    // Try the standard evaluateJavascript
                    var ValueCallback = Java.use("android.webkit.ValueCallback");
                    
                    var callback = Java.registerClass({
                        name: 'com.example.WebViewCallback',
                        implements: [ValueCallback],
                        methods: {
                            onReceiveValue: function(value) {
                                // console.log("[*] Javascript execution result: " + value);
                            }
                        }
                    });
                    
                    webViewInstance.evaluateJavascript(scriptToInject, callback.$new());
                    console.log("[+] Successfully injected into WebView via evaluateJavascript.");
                } catch (e) {
                    console.log("[-] Error injecting into standard WebView: " + e);
                    
                    // Fallback for loadUrl
                    try {
                        console.log("[*] Trying loadUrl fallback...");
                        webViewInstance.loadUrl("javascript:(function(){" + scriptToInject + "})()");
                        console.log("[+] Successfully injected into WebView using loadUrl.");
                    } catch (e2) {
                        console.log("[-] Error with loadUrl fallback: " + e2);
                    }
                }
            });
        }
        
        // 1. Hook android.webkit.WebView.loadUrl to catch WebViews as they navigate
        try {
            var WebView = Java.use("android.webkit.WebView");
            WebView.loadUrl.overload('java.lang.String').implementation = function(url) {
                console.log("[*] WebView.loadUrl called with URL: " + url);
                this.loadUrl(url); // Call original
                injectIntoWebView(this);
            };
            console.log("[*] Hooked android.webkit.WebView.loadUrl");
        } catch (e) {
            console.log("[-] Could not hook android.webkit.WebView.loadUrl: " + e);
        }
        
        // 2. Fallback: Hook Android System WebView / Chrome Custom Tabs
        // org.chromium.android_webview.AwContents is the core chromium webview implementation
        try {
            var AwContents = Java.use("org.chromium.android_webview.AwContents");
            AwContents.loadUrl.overload('java.lang.String', 'java.util.Map').implementation = function(url, additionalHttpHeaders) {
                console.log("[*] AwContents.loadUrl called with URL: " + url);
                this.loadUrl(url, additionalHttpHeaders); // Call original
                
                // If it's AwContents, it's usually wrapped by android.webkit.WebView, 
                // so the hook above might catch it. If not, we log it.
                console.log("[*] Detected Chromium WebView navigation. Standard WebView hook should catch if wrapped.");
            };
            console.log("[*] Hooked org.chromium.android_webview.AwContents.loadUrl");
        } catch(e) {
            console.log("[-] org.chromium.android_webview.AwContents not found or couldn't be hooked.");
        }
        
        console.log("[*] Waiting for WebViews to load URLs...");
    });
    """ % json.dumps(combined_script)
    
    try:
        print("[*] Attaching to USB device...")
        device = frida.get_usb_device()
        print(f"[*] Attaching to {TARGET_PACKAGE}...")
        session = device.attach(TARGET_PACKAGE)
        
        print("[*] Creating script...")
        script = session.create_script(frida_script_code)
        
        def on_message(message, data):
            if message['type'] == 'send':
                print(message['payload'])
            elif message['type'] == 'error':
                print(f"[!] Frida Error: {message['stack']}")
                
        script.on('message', on_message)
        script.load()
        
        print("[*] Script loaded! Press Ctrl+C to stop.")
        sys.stdin.read()
        
    except frida.ProcessNotFoundError:
        print(f"[!] Application {TARGET_PACKAGE} is not running. Please start it on the device first.")
    except Exception as e:
        print(f"[!] Error: {e}")
        
if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n[*] Exiting...")
        sys.exit(0)
