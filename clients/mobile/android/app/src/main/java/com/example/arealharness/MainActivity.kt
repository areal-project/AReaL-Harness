package com.example.arealharness

import android.os.Bundle
import com.getcapacitor.BridgeActivity

open class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(ArealKeychainPlugin::class.java)
        super.onCreate(savedInstanceState)
    }
}
