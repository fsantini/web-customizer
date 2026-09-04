/* [Main Dimensions] */
// Outer spool diameter
outerDiameter = 74;
// Core diameter
coreDiameter = 20;
// Total height
height = 25;
// Wall thickness
thickness = 2;
// Horizontal hole in the core (0 to disable)
coreHoleDiameter = 3;

/* [Lightweighting] */
// Base diameter of the holes in the sides
lightweightingHoleDiameter = 10;
// Percentage of ideal lightweighting (0 = solid sides)
lightnessFactor = 100; // [0:120]

/* [Machining] */
// Tolerance for fitting parts together [mm]
tolerance = 0.2;
// Slots in the bottom core. Increase if the bottom does not fit into the top.
slotSizeMultiplier = 1.5;

/* [View] */
// Show the two sides as separate for printing
printView = true;
// Rendering resolution
$fn = 50;


module rim(h, d)
{
    // outer rim
    difference()
    {
        cylinder(h=h, d=d);
        translate([0,0,-1])
        {
            cylinder(h=h+2, d=d-thickness);
        }
    }
}


module torus(od, id)
{
    rotate_extrude(convexity = 10)
        translate([od/2, 0, 0]) // Major radius (distance from center to tube center)
            circle(r = id/2);   // Minor radius (tube radius)
}

module halftorus(od, id)
{
    difference()
    {
        torus(od,id);
        translate([-od,-od, 0])
        {
            cube([od*2, od*2, id*2]);
        }
    }
}

module plate() {
    difference()
    {
        cylinder(h=thickness, d=outerDiameter);
        // hole array
        translate([0,0,-1])
        {
            for (y = [-outerDiameter/2:2*(lightweightingHoleDiameter+thickness)/sqrt(2):outerDiameter/2])
            {
                translate([0,y,0])
                {
                    for (x = [-outerDiameter/2:2*(lightweightingHoleDiameter+thickness)/sqrt(2):outerDiameter/2])
                    {
                        translate([x,0,0])
                        {
                            cylinder(h=thickness+2, d=lightweightingHoleDiameter*lightnessFactor/100); 
                            translate([(lightweightingHoleDiameter+thickness)/sqrt(2), (lightweightingHoleDiameter+thickness)/sqrt(2), 0])
                            {
                                cylinder(h=thickness+2, d=lightweightingHoleDiameter*lightnessFactor/100); 
                            }
                        }
                    }
                }
            }
        }
    }
    rim(thickness, outerDiameter);
}

bottomInnerOuterDiameter = coreDiameter - thickness - tolerance;
bottomInnerInnerDiameter = bottomInnerOuterDiameter - thickness;

module bottom()
{
    difference()
    {
        union()
        {
            plate();
            cylinder(h=height, d=bottomInnerOuterDiameter);
            translate([0,0,height])
            {
                halftorus(bottomInnerOuterDiameter, thickness*2-tolerance);
            }
        }
        translate([0,0,-1])
        {
            cylinder(h=height+2, d=bottomInnerInnerDiameter);
            // cuts for the groove
            translate([0, 0, height+1])
            {
                cube([2*bottomInnerOuterDiameter, slotSizeMultiplier*thickness, height], center=true);
                cube([slotSizeMultiplier*thickness, 2*bottomInnerOuterDiameter, height], center=true);
            }
        }
        translate([0,outerDiameter/2,height/2])
        {
            rotate(a=[90,0,0])
            {
                cylinder(h=outerDiameter, d=coreHoleDiameter);
            }
        }
        
    }
}

        

topInnerInnerDiameter = coreDiameter - thickness;
topInnerOuterDiameter = coreDiameter;
topCoreHeight = height - thickness - tolerance;

module top()
{
    translate([0,0,height])
    {
        rotate(a=[180,0,0])
        {
            difference()
            {
                union()
                {
                    plate();
                    cylinder(h=topCoreHeight, d=topInnerOuterDiameter);
                    rotate(a=[180,0,0])
                    {
                        halftorus(bottomInnerOuterDiameter, thickness*2*2);
                    }                   
                }
                translate([0,0,-1])
                {
                    cylinder(h=height+2, d=topInnerInnerDiameter);
                }
                translate([0,0,-000.1])
                {
                    rotate(a=[180,0,0])
                    {
                        halftorus(bottomInnerOuterDiameter, thickness*2);
                    }
                }
                translate([0,outerDiameter/2,height/2])
                {
                    rotate(a=[90,0,0])
                    {
                        cylinder(h=outerDiameter, d=coreHoleDiameter);
                    }
                }
            }
        }
    }
}

bottom();

if (printView)
{
    translate([outerDiameter + 5, 0, 0])
        rotate(a=[180,0,0])
            translate([0,0,-height])
                top();
} else
{
    top();
}
    
    
