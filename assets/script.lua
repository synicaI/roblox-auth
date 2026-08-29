-- default configuration.

shared.Global = {
    ['Script'] = {
        ['Key'] = 'your key here',
        ['Debug'] = false -- true: prints status/errors for testing id recommend to leave this on true if its your first execution, otherwise leave it false.
    },

    ['Silent'] = {
        ['Enabled'] = true,
        ['Safety'] = true,
        ['Mode'] = 'Target',
        ['Auto'] = true,
        ['Prediction'] = {  
            ['X'] = 0.26,  
            ['Y'] = 0.26,  
            ['Z'] = 0.26 
        }
    },

-- camlock / aim assist 
    ['Camera'] = {
        ['Enabled'] = true,
        ['Distance'] = 450,
        ['MouseButton2'] = true,
        ['FOV'] = 240,

        ['Configurations'] = {
            ['Value'] = 0.011,
            ['ThirdPerson'] = false,
            ['FirstPerson'] = true, 
        },

        ['Prediction'] = {  
            ['X'] = 0.1225, 
            ['Y'] = 0.1225, 
            ['Z'] = 0.1225 
        }
    },

-- mod detector [WORKS ON VF ONLY] 
    ['ModDetector'] = {
        ['Enabled'] = true
    },

-- memory spoofer
    ['MemorySpoofer'] = {
        ['Enabled'] = true,
        ['MinValue'] = 974,
        ['MaxValue'] = 981,
        ['DecimalPlaces'] = 1,
    },

-- ping spoofer
    ['PingSpoofer'] = {
        ['Enabled'] = true,
        ['MinValue'] = 50,
        ['MaxValue'] = 70,
        ['DecimalPlaces'] = 1,
    },

-- anti curve
    ['Control'] = {  
        ['BlockLowHits'] = true,
        ['Align'] = true,
        ['VerticalSensitivity'] = 'tight',
        ['DistanceModule'] = { 
            ['HorizontalDelta'] = '300',
            ['VerticalDelta'] = '300',
        },
    },

-- speedhack and jumppower
['Movement Modification'] = {
    ['Enabled'] = true,
    ['Speed'] = {
        ['Default'] = 16,
        ['Keybinds'] = {
            ['Increase'] = 'M',
            ['Decrease'] = 'N',
        },
    },
    ['JumpPower'] = {
        ['Default'] = 50,
        ['Keybinds'] = {
            ['Increase'] = 'L',
            ['Decrease'] = 'K',
        },
    },
    ['Mode'] = 'toggle',
    ['ToggleKey'] = 'V'
},

-- fov per weapon
    ['FOV'] = {
        ['Revolver'] = {10, 10.2, 10.1},
        ['DoubleBarrelSG'] = {10, 10.2, 10.1},
        ['Rifle'] = {10, 10.2, 10.1},
        ['TacticalShotgun'] = {10, 10.2, 10.1},
        ['AUG'] = {10, 10.2, 10.1},
    },

    ['Hits'] = {
        ['power'] = '1',
    },

-- hitbox size
    ['Hitbox'] = {
        ['Enabled'] = false,
        ['Guns'] = {
            ['[Double-Barrel SG]'] = { H = 0.6, W = 0.6 },
            ['[Revolver]'] = { H = 0.6, W = 0.6 },
            ['[Tactical SG]'] = { H = 0.6, W = 0.6 },
            ['[Rifle]'] = { H = 6.2, W = 6.2 }
        }
    },

-- triggerbot
    ['Trigger'] = {
        ['Enabled'] = true,  
        ['Config'] = {
            ['Safety'] = true,  
            ['Auto'] = true,
            ['Mode'] = 'ClosestPart', 
        },
        ['Start'] = 0.001, 
        ['End'] = 0.002, 
        ['Mode'] = "toggle",  
    },

-- hitchance
    ['Chances'] = {
        ['Active'] = true,
        ['Stats'] = {
            ['Rev'] = '1000', 
            ['DB'] = '1000', 
            ['Shot'] = '1000',
            ['TacShot'] = '1000', 
            ['SMG'] = '1000', 
            ['Sil'] = '1000',
            ['AR'] = '1000', 
            ['Other'] = '1000'
        }
    },
    
-- spread modifications
    ['Spread modifications'] = { 
        ['Mode'] = "Randomizer", -- "Normal" // "Randomizer"
        ['Spread Modifier'] = {
            Multiplier = 0.1
        },
        ['Spread Randomizer'] = {
            Start = 0.4,
            End = 0.5
        },
        ['Enabled'] = false,
        ['Toggle Key'] = "L"
    },

-- inventory sorter
    ['Inventory'] = {  
        ['Enabled'] = false,
        ['Keybind'] = 'E',  
        ['Order'] = {
            ['[Revolver]'] = 2,
            ['[Double-Barrel SG]'] = 1,
            ['[TacticalShotgun]'] = 3,
            ['[knife]'] = 4,
        }
    },

-- whitelist
    ['Core'] = {
        ['Enabled'] = false,
        ['Checks'] = {
            ['Whitelist'] = {
                'Player1',
                'Player2',
            }
        },
    },

-- macro
    ['Macro'] = {
        ['Settings'] = {
            ['Enabled'] = false,  
            ['Mode'] = 'toggle'  
        },
        ['Configurations'] = {
            ['Enabled'] = false,  
            ['Duration'] = 5,
            ['Frequency'] = 0.1,
        }
    },

-- keybinds
    ['Keys'] = {
        ['Target'] = "C",  
        ['Cancel'] = "B",   
        ['Trigger'] = 'U',
        ['Macro'] = 'X',
    },
}

loadstring(game:HttpGet("https://raw.githubusercontent.com/erisiu-xx/xx/refs/heads/main/xx.lua"))()
